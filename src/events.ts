// 事件聚簇与热度。
// 聚簇：LLM 模式下由判断步骤直接给出"属于哪个近期事件"；规则模式（或 LLM 给了无效编号）用标题词法相似度。
// 热度（照搬 AIHOT events/hot.ts）：48 小时窗口内，每个独立媒体只算一次，按 24 小时半衰期衰减。
import { all, get, run } from "./db.ts";
import { similarity, tokens } from "./lib/text.ts";

export const JOIN_MIN_SIMILARITY = 0.3;
const WINDOW_HOURS = 48;
const HALF_LIFE_HOURS = 24;
/** 事件里最重要的一篇也不到这个分，就不进热点（噪声太多）。 */
const HOT_MIN_IMPORTANCE = 40;

export interface EventRow {
  id: number;
  topic: string;
  title: string;
  title_zh: string | null;
  tokens: string;
  first_at: number;
  last_at: number;
  best_importance: number;
}

export interface ArticleForEvent {
  id: number;
  topic: string;
  title: string;
  title_zh: string | null;
  importance: number;
  entities: string[];
  timeline_at: number;
}

const eventTokens = (a: { title: string; entities: string[] }) => [...new Set([...tokens(a.title), ...a.entities.flatMap((e) => tokens(e))])];

/** 某个时间点附近的事件（LLM 判断时作为"近期事件"列表，规则模式作为召回范围）。 */
export function eventsNear(at: number, limit = 40): EventRow[] {
  return all<EventRow>(
    "SELECT * FROM events WHERE last_at > ? AND first_at < ? ORDER BY best_importance DESC, last_at DESC LIMIT ?",
    at - 72 * 3600_000, at + 24 * 3600_000, limit);
}

export function createEvent(a: ArticleForEvent): number {
  const res = run("INSERT INTO events (topic, title, title_zh, tokens, first_at, last_at, best_importance) VALUES (?, ?, ?, ?, ?, ?, ?)",
    a.topic, a.title, a.title_zh, JSON.stringify(eventTokens(a)), a.timeline_at, a.timeline_at, a.importance);
  const id = Number(res.lastInsertRowid);
  run("UPDATE articles SET event_id = ? WHERE id = ?", id, a.id);
  return id;
}

/** 挂到已有事件上；更重要的报道成为事件的代表标题。事件的关键词不随成员增长，避免越滚越大、把不相干的事串起来。 */
export function joinEvent(eventId: number, a: ArticleForEvent) {
  const ev = get<EventRow>("SELECT * FROM events WHERE id = ?", eventId);
  if (!ev) return createEvent(a);
  run("UPDATE articles SET event_id = ? WHERE id = ?", eventId, a.id);
  const better = a.importance > ev.best_importance;
  run(`UPDATE events SET first_at = min(first_at, ?), last_at = max(last_at, ?), best_importance = max(best_importance, ?),
         title = CASE WHEN ? THEN ? ELSE title END, title_zh = CASE WHEN ? AND ? IS NOT NULL THEN ? ELSE coalesce(title_zh, ?) END WHERE id = ?`,
    a.timeline_at, a.timeline_at, a.importance, better ? 1 : 0, a.title, better ? 1 : 0, a.title_zh, a.title_zh, a.title_zh, eventId);
  return eventId;
}

/** 规则模式：和附近事件的代表标题比词法相似度，够像就归进去，否则新建。 */
export function assignLexical(a: ArticleForEvent): number {
  const mine = eventTokens(a);
  let best: { id: number; sim: number } | null = null;
  for (const ev of eventsNear(a.timeline_at, 200)) {
    const sim = similarity(mine, JSON.parse(ev.tokens) as string[]);
    if (!best || sim > best.sim) best = { id: ev.id, sim };
  }
  return best && best.sim >= JOIN_MIN_SIMILARITY ? joinEvent(best.id, a) : createEvent(a);
}

export interface HotEvent {
  id: number;
  topic: string;
  title: string;
  heat: number;
  heatPrev: number;
  rising: boolean;
  isNew: boolean;
  publishers: number;
  latestAt: number;
  bestImportance: number;
  articles: Array<{ id: number; title: string; publisher: string | null; url: string; at: number; importance: number | null; summary: string | null }>;
}

const decay = (ageMs: number) => Math.pow(0.5, ageMs / 3600_000 / HALF_LIFE_HOURS);

/** 当前热点：按事件算，不按文章算。一家媒体发十篇也只算一次。 */
export function hotEvents(opts: { topic?: string | null; limit?: number; now?: number } = {}): HotEvent[] {
  const now = opts.now ?? Date.now();
  const since = now - WINDOW_HOURS * 3600_000;
  const prevAt = now - 6 * 3600_000;
  const rows = all<{ id: number; event_id: number; title: string; title_zh: string | null; summary_zh: string | null; publisher: string | null; url: string; timeline_at: number; importance: number | null }>(
    `SELECT id, event_id, title, title_zh, summary_zh, publisher, url, timeline_at, importance FROM articles
     WHERE event_id IS NOT NULL AND relevant = 1 AND backfill = 0 AND timeline_at > ? AND timeline_at <= ?`, since, now);
  const byEvent = new Map<number, typeof rows>();
  for (const r of rows) byEvent.set(r.event_id, [...(byEvent.get(r.event_id) ?? []), r]);

  const events = new Map(all<EventRow>(`SELECT * FROM events WHERE id IN (${[...byEvent.keys()].join(",") || "0"})`).map((e) => [e.id, e]));
  const out: HotEvent[] = [];
  for (const [eventId, list] of byEvent) {
    const ev = events.get(eventId);
    if (!ev || (opts.topic && ev.topic !== opts.topic) || ev.best_importance < HOT_MIN_IMPORTANCE) continue;
    // 每个媒体取它最近一次报道的时间。
    const latest = new Map<string, number>();
    const latestPrev = new Map<string, number>();
    for (const a of list) {
      const p = (a.publisher ?? a.url).toLowerCase();
      latest.set(p, Math.max(latest.get(p) ?? 0, a.timeline_at));
      if (a.timeline_at <= prevAt) latestPrev.set(p, Math.max(latestPrev.get(p) ?? 0, a.timeline_at));
    }
    const heat = [...latest.values()].reduce((s, t) => s + decay(now - t), 0);
    const heatPrev = [...latestPrev.values()].filter((t) => t > prevAt - WINDOW_HOURS * 3600_000).reduce((s, t) => s + decay(prevAt - t), 0);
    list.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || b.timeline_at - a.timeline_at);
    out.push({
      id: eventId,
      topic: ev.topic,
      title: ev.title_zh ?? ev.title,
      heat: Math.round(heat * 100) / 10,
      heatPrev: Math.round(heatPrev * 100) / 10,
      rising: heat - heatPrev > 0.5,
      isNew: latestPrev.size === 0,
      publishers: latest.size,
      latestAt: Math.max(...latest.values()),
      bestImportance: ev.best_importance,
      articles: list.slice(0, 8).map((a) => ({ id: a.id, title: a.title_zh ?? a.title, publisher: a.publisher, url: a.url, at: a.timeline_at, importance: a.importance, summary: a.summary_zh })),
    });
  }
  // 热度相同（比如都只有一家报道）时，更重要、更新的排前面。
  out.sort((a, b) => b.heat - a.heat || b.bestImportance - a.bestImportance || b.latestAt - a.latestAt);
  return out.slice(0, opts.limit ?? 20);
}
