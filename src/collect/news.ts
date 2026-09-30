// 新闻采集：到期的信源进来抓一次；失败不前进、指数退避；每 6 小时按产出调整抓取间隔。
import { SOURCES } from "../../config/sources.ts";
import { all, get, getKv, run, setKv } from "../db.ts";
import { ingest } from "../ingest.ts";
import { fetchText, pool } from "../lib/http.ts";
import { gnewsUrl, parseFeed, type Candidate } from "./rss.ts";

const MAX_ITEMS_PER_RUN = 60;

interface SourceRow {
  id: string;
  name: string;
  kind: "gnews" | "rss";
  topic: string;
  target: string;
  interval_min: number;
  fail_count: number;
  etag: string | null;
  last_modified: string | null;
}

/** 配置里的信源写进库：新的插入，改过的更新文案和地址，运行状态保留。 */
export function seedSources() {
  for (const s of SOURCES) {
    run(`INSERT INTO sources (id, name, kind, topic, target, first_party, interval_min) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, topic = excluded.topic, target = excluded.target, first_party = excluded.first_party`,
      s.id, s.name, s.kind, s.topic, s.target, s.firstParty ? 1 : 0, s.intervalMin);
  }
  const ids = SOURCES.map((s) => s.id);
  run(`UPDATE sources SET enabled = 0 WHERE id NOT IN (${ids.map(() => "?").join(",")})`, ...ids);
}

export async function collectSource(id: string): Promise<{ id: string; found: number; created: number; notModified?: boolean; error?: string }> {
  const s = get<SourceRow>("SELECT * FROM sources WHERE id = ?", id);
  if (!s) return { id, found: 0, created: 0, error: "missing" };
  const now = Date.now();
  try {
    const url = s.kind === "gnews" ? gnewsUrl(`${s.target} when:2d`) : s.target;
    const res = await fetchText(url, { etag: s.etag, lastModified: s.last_modified });
    let candidates: Candidate[] = [];
    if (!res.notModified) {
      candidates = parseFeed(res.text, { google: s.kind === "gnews", publisher: s.kind === "rss" ? s.name : undefined });
      candidates.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
      candidates = candidates.slice(0, MAX_ITEMS_PER_RUN);
    }
    let created = 0;
    for (const c of candidates) if (ingest(s.id, s.topic, c)?.created) created++;
    run(`UPDATE sources SET last_fetch_at = ?, last_ok_at = ?, fail_count = 0, health = 'ok', last_error = NULL, etag = ?, last_modified = ?,
           initialized = 1, next_fetch_at = ? WHERE id = ?`,
      now, now, res.etag, res.lastModified, now + s.interval_min * 60_000, id);
    return { id, found: candidates.length, created, notModified: res.notModified || undefined };
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 500);
    // 失败不前进：下次从同一处再来；间隔按失败次数拉长，最长 6 小时。
    const backoff = Math.min(s.interval_min * (s.fail_count + 2), 360);
    run(`UPDATE sources SET last_fetch_at = ?, fail_count = fail_count + 1, last_error = ?,
           health = CASE WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END, next_fetch_at = ? WHERE id = ?`,
      now, message, now + backoff * 60_000, id);
    return { id, found: 0, created: 0, error: message };
  }
}

/** 到期的信源（从没抓过的优先），有限并发地抓。 */
export async function collectDue(limit = 30) {
  const now = Date.now();
  const due = all<{ id: string }>(
    "SELECT id FROM sources WHERE enabled = 1 AND (next_fetch_at IS NULL OR next_fetch_at <= ?) ORDER BY next_fetch_at IS NOT NULL, next_fetch_at LIMIT ?", now, limit);
  // 先占位，防止下一个 tick 重复抓同一个源。
  for (const d of due) run("UPDATE sources SET next_fetch_at = ? WHERE id = ?", now + 10 * 60_000, d.id);
  const results = await pool(due.map((d) => d.id), 4, collectSource);
  const ok = results.filter((r) => !(r instanceof Error) && !r.error) as Array<{ created: number }>;
  return { due: due.length, ok: ok.length, created: ok.reduce((n, r) => n + r.created, 0) };
}

/** 近 7 天产出多的抓得勤（最短 15 分钟），安静的放慢（最长 60 分钟）。都是免费源，所以上限不高。 */
export function adaptIntervals(force = false) {
  const last = getKv<number>("adapt_intervals_at");
  if (!force && last && Date.now() - last.value < 6 * 3600_000) return null;
  const now = Date.now();
  const rows = all<{ id: string; n: number; first: number | null }>(`
    SELECT s.id, count(a.id) AS n, min(a.discovered_at) AS first
    FROM sources s LEFT JOIN articles a ON a.source_id = s.id AND a.discovered_at > ? AND a.backfill = 0
    WHERE s.enabled = 1 GROUP BY s.id`, now - 7 * 86400_000);
  let updated = 0;
  for (const r of rows) {
    if (!r.n || !r.first) continue;
    // 按实际观察的天数算（刚加的信源不满 7 天，按 7 天除会低估）。
    const days = Math.max(1, Math.min(7, (now - r.first) / 86400_000));
    const perDay = r.n / days;
    const target = Math.round(Math.min(60, Math.max(15, (24 * 60) / (perDay * 3))));
    updated += Number(run("UPDATE sources SET interval_min = ? WHERE id = ? AND interval_min <> ?", target, r.id, target).changes);
  }
  setKv("adapt_intervals_at", Date.now());
  return { updated };
}

/**
 * 历史回溯：用 Google News 的日期搜索补齐某段时间的新闻（给异动归因和评测用）。
 * 超过 48 小时的旧文由 ingest 的时间线规则按原文时间归档，不进"最近"、不算热度；当天的新闻照常算。
 */
export async function backfillNews(query: string, topic: string, fromDate: string, toDate: string): Promise<{ found: number; created: number; ids: number[] }> {
  const res = await fetchText(gnewsUrl(`${query} after:${fromDate} before:${toDate}`));
  const candidates = parseFeed(res.text, { google: true }).slice(0, 40);
  let created = 0;
  const ids: number[] = [];
  for (const c of candidates) {
    const r = ingest("backfill", topic, c);
    if (!r) continue;
    ids.push(r.id);
    if (r.created) created++;
  }
  return { found: candidates.length, created, ids };
}
