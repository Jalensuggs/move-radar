// 异动检测与归因。
// 检测：日涨跌幅 ÷ 过去 60 个交易日涨跌幅的标准差 = z 分数，|z| ≥ 2 算异动（对 VIX 这种天生波动大的也公平）。
// 归因：取异动前一个收盘到当天收盘的新闻 → 按"和这个标的有多相关 × 有多重要 × 多少家在报"排候选事件
//       → LLM 从候选里选出主因并写解释（不许选候选以外的东西），规则模式直接取第一名。
import { z } from "zod";
import type { AssetSpec } from "../config/assets.ts";
import { allAssets, findAsset } from "./assets.ts";
import { all, get, run } from "./db.ts";
import { backfillNews } from "./collect/news.ts";
import { dayReturns } from "./collect/market.ts";
import { processQueue } from "./judge.ts";
import { callJson, llmMode } from "./llm.ts";
import { addDays, etDate } from "./lib/text.ts";

export const MOVE_Z = Number(process.env.MOVE_Z || 2.0);
const LOOKBACK = 60;
const AUTO_ATTRIBUTE_DAYS = Number(process.env.AUTO_ATTRIBUTE_DAYS || 45);
const CONTEXT_SYMBOLS = ["SPX", "COMP", "SOX", "VIX", "USO", "GLD"];

export interface MoveRow {
  symbol: string;
  date: string;
  ret: number;
  z: number;
  close: number;
  forced: number;
  backfilled_at: number | null;
  attribution: string | null;
  attributed_at: number | null;
}

function std(xs: number[]): number {
  const m = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** 某个标的在某天的涨跌幅和 z 分数（不管是否超过阈值）。 */
export function moveStats(symbol: string, date: string): { ret: number; z: number; close: number; prevDate: string } | null {
  const rows = all<{ date: string; close: number }>("SELECT date, close FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT ?", symbol, date, LOOKBACK + 2).reverse();
  if (rows.length < 30 || rows.at(-1)!.date !== date) return null;
  const rets = rows.slice(1).map((r, i) => r.close / rows[i]!.close - 1);
  const ret = rets.at(-1)!;
  const sd = std(rets.slice(0, -1));
  return { ret, z: sd > 0 ? ret / sd : 0, close: rows.at(-1)!.close, prevDate: rows.at(-2)!.date };
}

/** 检测异动。不传就检测所有标的（内置 + 自选）；加入一只新自选时只检测它。 */
export function detectMoves(assets: AssetSpec[] = allAssets()): { found: number } {
  let found = 0;
  for (const a of assets) {
    const rows = all<{ date: string; close: number }>("SELECT date, close FROM prices WHERE symbol = ? ORDER BY date", a.symbol);
    const rets = rows.slice(1).map((r, i) => r.close / rows[i]!.close - 1);
    for (let i = LOOKBACK; i < rets.length; i++) {
      const sd = std(rets.slice(i - LOOKBACK, i));
      const z = sd > 0 ? rets[i]! / sd : 0;
      const row = rows[i + 1]!;
      if (Math.abs(z) >= MOVE_Z) {
        run(`INSERT INTO moves (symbol, date, ret, z, close) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(symbol, date) DO UPDATE SET ret = excluded.ret, z = excluded.z, close = excluded.close`, a.symbol, row.date, rets[i]!, z, row.close);
        found++;
      } else {
        // 盘中算出来的异动，收盘时回落到阈值以下：撤掉（手动要求归因的保留）。
        run("DELETE FROM moves WHERE symbol = ? AND date = ? AND forced = 0", a.symbol, row.date);
      }
    }
  }
  return { found };
}

// ── 归因 ─────────────────────────────────────────────────────────────────────

export interface Candidate {
  ref: string;
  eventId: number | null;
  title: string;
  titleOriginal: string;
  publisher: string | null;
  url: string;
  at: number;
  importance: number;
  publishers: number;
  direct: boolean;
  score: number;
}

export interface Attribution {
  mode: "llm" | "rules";
  primary: Candidate | null;
  supporting: Candidate[];
  explanation: string;
  confidence: "high" | "medium" | "low";
  candidates: Candidate[];
  context: Record<string, number | null>;
  window: { from: number; to: number };
  newsCount: number;
}

/** 美股收盘 16:00 ET ≈ 20:00/21:00 UTC。窗口：前一交易日午盘（含盘后、隔夜、盘前）到当天收盘。 */
function windowFor(prevDate: string, date: string) {
  return { from: Date.parse(`${prevDate}T15:00:00Z`), to: Date.parse(`${date}T21:00:00Z`) };
}

function candidatesFor(a: AssetSpec, from: number, to: number): { list: Candidate[]; newsCount: number } {
  // 内置标的：只看被判为"相关"的新闻。自选股可能不在四条主线里（苹果、特斯拉……），
  // 新闻会被判成不相关，所以标题里直接点到它的也算候选。
  const esc = (k: string) => k.replace(/[\\%_]/g, "\\$&");
  const direct = a.custom ? a.keywords.map(() => "lower(title) LIKE ? ESCAPE '\\'").join(" OR ") : "";
  const rows = all<{ id: number; event_id: number | null; title: string; title_zh: string | null; publisher: string | null; url: string; timeline_at: number; importance: number | null; topic: string; entities: string | null }>(
    `SELECT id, event_id, title, title_zh, publisher, url, timeline_at, importance, topic, entities FROM articles
     WHERE timeline_at BETWEEN ? AND ? AND ((relevant = 1 AND topic IN (${a.topics.map(() => "?").join(",")}))${direct ? ` OR (${direct})` : ""})`,
    from, to, ...a.topics, ...(a.custom ? a.keywords.map((k) => `%${esc(k)}%`) : []));
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = r.event_id ? `e${r.event_id}` : `a${r.id}`;
    byGroup.set(k, [...(byGroup.get(k) ?? []), r]);
  }
  const list: Candidate[] = [];
  for (const group of byGroup.values()) {
    const direct = (r: (typeof rows)[number]) => a.keywords.some((k) => ` ${r.title} ${r.entities ?? ""} `.toLowerCase().includes(k));
    group.sort((x, y) => Number(direct(y)) - Number(direct(x)) || (y.importance ?? 0) - (x.importance ?? 0));
    const best = group[0]!;
    const publishers = new Set(group.map((g) => (g.publisher ?? g.url).toLowerCase())).size;
    const isDirect = group.some(direct);
    list.push({
      ref: "", eventId: best.event_id, title: best.title_zh ?? best.title, titleOriginal: best.title, publisher: best.publisher, url: best.url,
      at: best.timeline_at, importance: best.importance ?? 0, publishers, direct: isDirect,
      score: Math.round((best.importance ?? 0) + (isDirect ? 25 : 0) + 8 * Math.log2(1 + publishers)),
    });
  }
  list.sort((x, y) => y.score - x.score);
  const top = list.slice(0, 12);
  top.forEach((c, i) => (c.ref = `C${i + 1}`));
  return { list: top, newsCount: rows.length };
}

const pct = (x: number | null | undefined) => (x == null ? "无数据" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`);

const ATTRIBUTE_SYSTEM = `你是美股盘后分析师。给你某个资产某天的异常涨跌、同一天其他主要资产的表现，以及这段时间的候选新闻事件，请判断最可能的驱动因素。
规则：
- 主因只能从候选事件里选，用编号引用（如 "C3"）；都不像就填 "none"，并在解释里说明（比如"大盘普跌，个股跟随"或"没有找到明确的新闻"）。
- 先看是不是大盘或板块共振：如果标普、纳指或费城半导体同向大幅波动，个股异动可能主要是跟随，要在解释里点明。
- 方向要对得上：利好新闻不能解释大跌，除非是"利好出尽"之类有依据的逻辑。
- supporting 放 0-3 个次要因素的编号。
- explanation_zh 用中文，80 字以内，先给结论再给依据，不要编造候选里没有的事实和数字。
- confidence：high = 有直接点名该资产的重大新闻且方向吻合；medium = 有相关新闻但不是直接原因，或方向存疑；low = 只是推测。`;

const AttributeSchema = z.object({
  primary: z.string().catch("none"),
  supporting: z.array(z.string()).catch([]),
  explanation_zh: z.string(),
  confidence: z.enum(["high", "medium", "low"]).catch("low"),
});
const ATTRIBUTE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["primary", "supporting", "explanation_zh", "confidence"],
  properties: {
    primary: { type: "string" },
    supporting: { type: "array", items: { type: "string" } },
    explanation_zh: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
};

function rulesAttribution(a: AssetSpec, ret: number, z: number, cands: Candidate[], context: Record<string, number | null>): Pick<Attribution, "primary" | "supporting" | "explanation" | "confidence"> {
  if (Math.abs(z) < 1.5) {
    return { primary: null, supporting: cands.slice(0, 3), confidence: "low",
      explanation: `规则模式：当天涨跌 ${pct(ret)}，在正常波动范围内（${Math.abs(z).toFixed(1)} 倍波动率），不需要特别的解释。下面是当天最相关的新闻。` };
  }
  const market = context.SPX ?? context.COMP;
  // 大盘同向大动，而且个股的幅度没有远超大盘，才算"共振"（英伟达 -17% 而纳指 -3%，就不是跟随）。
  const coMove = a.group !== "market" && market != null && Math.sign(market) === Math.sign(ret) && Math.abs(market) > 0.012 && Math.abs(ret) < 2.5 * Math.abs(market);
  const top = cands[0] && cands[0].score >= 55 ? cands[0] : null;
  const parts = [top ? `得分最高的相关事件是「${top.title}」（${top.publisher ?? "未知来源"}）。` : "没有找到足够相关的新闻。"];
  if (coMove) parts.push(`当天标普 ${pct(context.SPX)}、纳指 ${pct(context.COMP)}，可能主要是大盘共振。`);
  return { primary: top, supporting: cands.slice(1, 3), explanation: `规则模式：${parts.join("")}`, confidence: top?.direct && top.importance >= 70 ? "medium" : "low" };
}

export async function attributeMove(symbol: string, date: string, opts: { force?: boolean } = {}): Promise<Attribution | null> {
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown symbol ${symbol}`);
  let move = get<MoveRow>("SELECT * FROM moves WHERE symbol = ? AND date = ?", symbol, date);
  const stats = moveStats(symbol, date);
  if (!stats) return null;
  if (!move) {
    // 没到阈值但被要求归因（页面上点的，或评测）：记为 forced。
    run("INSERT INTO moves (symbol, date, ret, z, close, forced) VALUES (?, ?, ?, ?, ?, 1)", symbol, date, stats.ret, stats.z, stats.close);
    move = get<MoveRow>("SELECT * FROM moves WHERE symbol = ? AND date = ?", symbol, date)!;
  }
  const { from, to } = windowFor(stats.prevDate, date);

  // 1. 历史回溯：我们开始采集之前的异动，当时的新闻库里没有，按日期去 Google News 补。
  if (!move.backfilled_at || opts.force) {
    const queries = [a.newsQuery, ...(a.group === "market" ? [] : ["stock market today"])];
    for (const q of queries) {
      try {
        await backfillNews(q, a.topics[0]!, stats.prevDate, addDays(date, 1));
      } catch {
        // 回溯尽力而为
      }
    }
    run("UPDATE moves SET backfilled_at = ? WHERE symbol = ? AND date = ?", Date.now(), symbol, date);
  }
  // 2. 窗口里还没判断过的资料，现在就判断（不等下一轮调度）。
  const pending = all<{ id: number }>("SELECT id FROM articles WHERE state = 'new' AND timeline_at BETWEEN ? AND ?", from, to).map((r) => r.id);
  for (let i = 0; i < pending.length; i += 48) await processQueue(48, pending.slice(i, i + 48));

  // 3. 候选事件 + 当天大盘背景。
  const { list: cands, newsCount } = candidatesFor(a, from, to);
  const context = dayReturns(date, [...new Set([symbol, ...CONTEXT_SYMBOLS])]);

  let result: Pick<Attribution, "primary" | "supporting" | "explanation" | "confidence">;
  let mode: Attribution["mode"] = "rules";
  if (llmMode().mode === "llm" && cands.length) {
    try {
      const user = [
        `资产：${a.name}（${a.symbol}${a.note ? `，${a.note}` : ""}）`,
        `日期：${date}（美东收盘）`,
        `涨跌：${pct(stats.ret)}，约为近 60 个交易日波动率的 ${Math.abs(stats.z).toFixed(1)} 倍`,
        `同日其他资产：${CONTEXT_SYMBOLS.filter((s) => s !== symbol).map((s) => `${findAsset(s)?.name ?? s} ${pct(context[s])}`).join("，")}`,
        "",
        "候选事件（按相关度排序，[直接] 表示新闻直接提到了这个资产）：",
        ...cands.map((c) => `${c.ref}: ${c.titleOriginal}${c.title !== c.titleOriginal ? `（${c.title}）` : ""}｜${c.publisher ?? "未知"}｜${new Date(c.at).toISOString().slice(0, 16)}Z｜重要度 ${c.importance}｜${c.publishers} 家报道${c.direct ? "｜[直接]" : ""}`),
      ].join("\n");
      const out = await callJson({ purpose: "attribute", system: ATTRIBUTE_SYSTEM, user, schema: ATTRIBUTE_JSON_SCHEMA, validate: AttributeSchema, effort: "medium" });
      const byRef = new Map(cands.map((c) => [c.ref, c]));
      result = {
        primary: byRef.get(out.primary) ?? null,
        supporting: out.supporting.map((r) => byRef.get(r)).filter((c): c is Candidate => !!c).slice(0, 3),
        explanation: out.explanation_zh,
        confidence: out.confidence,
      };
      mode = "llm";
    } catch {
      result = rulesAttribution(a, stats.ret, stats.z, cands, context);
    }
  } else {
    result = rulesAttribution(a, stats.ret, stats.z, cands, context);
  }
  const attribution: Attribution = { mode, ...result, candidates: cands, context, window: { from, to }, newsCount };
  run("UPDATE moves SET attribution = ?, attributed_at = ? WHERE symbol = ? AND date = ?", JSON.stringify(attribution), Date.now(), symbol, date);
  return attribution;
}

/** 每轮自动归因几条：最近的优先；当天的异动每 2 小时重算一次（新闻还在进来）。 */
export async function attributePending(limit = 3) {
  const today = etDate(Date.now());
  const since = addDays(today, -AUTO_ATTRIBUTE_DAYS);
  // 按需模式下没人在看：先不归因，等有人回来（那时新闻也判完了，归因更准）。
  const mode = llmMode().mode;
  if (mode === "wait") return { attributed: 0, waiting: true };
  // 能用模型时，之前规则模式做的归因也用模型重做。
  const redoRules = mode === "llm" ? 1 : 0;
  const rows = all<{ symbol: string; date: string }>(
    `SELECT symbol, date FROM moves WHERE date >= ? AND (attribution IS NULL OR (date >= ? AND attributed_at < ?)
       OR (? = 1 AND json_extract(attribution, '$.mode') = 'rules'))
     ORDER BY date DESC, abs(z) DESC LIMIT ?`, since, addDays(today, -1), Date.now() - 2 * 3600_000, redoRules, limit);
  let done = 0;
  for (const r of rows) {
    await attributeMove(r.symbol, r.date);
    done++;
  }
  return { attributed: done };
}
