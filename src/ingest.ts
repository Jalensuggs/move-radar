// 所有新资料的唯一入口（采集、历史回溯都走这里）：身份判重、修订、时间线规则。
// 照搬 AIHOT content/materials.ts 的思路：入口只有一个，就没有哪条路能绕过判重和"旧文不刷屏"。
import { get, run } from "./db.ts";
import type { Candidate } from "./collect/rss.ts";
import { collapse, normalizeUrl, sha1, tokens } from "./lib/text.ts";

/** 发现时原文已经发布超过这么久：按原文时间归档，不进"最近"，不算热度。 */
export const STALE_ON_DISCOVERY_MS = 48 * 3600_000;
/** 比发现时间还晚一小时以上的发布时间不可信。 */
const FUTURE_TOLERANCE_MS = 3600_000;

export interface IngestResult {
  id: number;
  created: boolean;
  revised: boolean;
}

export function decideTimeline(publishedAt: number | null, discoveredAt: number, explicitBackfill: boolean) {
  let published = publishedAt;
  if (published && published > discoveredAt + FUTURE_TOLERANCE_MS) published = null;
  const backfill = explicitBackfill || (!!published && discoveredAt - published > STALE_ON_DISCOVERY_MS);
  return { published, backfill, timelineAt: backfill && published ? published : published ?? discoveredAt };
}

export function ingest(sourceId: string, topic: string, c: Candidate, opts: { backfill?: boolean; now?: number } = {}): IngestResult | null {
  const now = opts.now ?? Date.now();
  const title = collapse(c.title);
  if (!title) return null;
  const identityKey = c.key ?? `url:${normalizeUrl(c.url)}`;
  const titleKey = sha1(`${tokens(title).join(" ")}|${(c.publisher ?? "").toLowerCase()}`).slice(0, 16);
  const hash = sha1(`${title}\u0001${c.excerpt ?? ""}`);

  const existing = get<{ id: number; content_hash: string }>("SELECT id, content_hash FROM articles WHERE identity_key = ?", identityKey);
  if (existing) {
    if (existing.content_hash === hash) return { id: existing.id, created: false, revised: false };
    // 内容变了（标题改了）：更新文本，重新判断。
    run("UPDATE articles SET title = ?, excerpt = ?, content_hash = ?, state = 'new', attempts = 0, retry_at = NULL WHERE id = ?",
      title, c.excerpt, hash, existing.id);
    return { id: existing.id, created: false, revised: true };
  }
  // 同一家媒体、同一个标题，换了个链接（不同搜索词、跟踪参数）：视为同一条。
  const twin = get<{ id: number }>("SELECT id FROM articles WHERE title_key = ? AND discovered_at > ?", titleKey, now - 7 * 86400_000);
  if (twin) return { id: twin.id, created: false, revised: false };

  const t = decideTimeline(c.publishedAt, now, !!opts.backfill);
  const res = run(
    `INSERT INTO articles (identity_key, title_key, source_id, topic, url, title, publisher, excerpt, published_at, discovered_at, timeline_at, backfill, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    identityKey, titleKey, sourceId, topic, c.url, title, c.publisher, c.excerpt, t.published, now, t.timelineAt, t.backfill ? 1 : 0, hash,
  );
  return { id: Number(res.lastInsertRowid), created: true, revised: false };
}
