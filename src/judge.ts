// 判断与写作：相关性、主线、重要度、中文标题摘要、实体、事件归属。
//
// 省钱的做法（每一条都用 DeepSeek 实跑的 1445 条数据量过，见 README「省钱」）：
//   - 20 条一批，一次调用同时完成预筛、打分、写作、归组（AIHOT 每条分好几步）；
//   - 中文标题和摘要只给相关、重要度 ≥ 45 的写——一半的条目不值得写，而输出比输入贵 4 倍；
//   - "独立打两次分"只对门槛附近 ±10 分的条目做，可以关掉；
//   - 这几类根本不送模型：荐股软文（规则一眼能认出）、历史回溯的旧闻（归因时模型只看标题）、
//     和刚判过的报道标题几乎一样的（同一件事的其他媒体，直接沿用判断）、没人在看时已经过时的新闻。
// 没有 LLM 时走规则模式，结构完全一样，只是判断粗糙一些。
import { z } from "zod";
import { NOISE_PATTERNS, TIER1_PUBLISHERS, TOPICS, type TopicKey } from "../config/topics.ts";
import { ASSETS } from "../config/assets.ts";
import { all, run } from "./db.ts";
import { assignLexical, createEvent, eventsNear, joinEvent, type ArticleForEvent } from "./events.ts";
import { BudgetExceededError, callJson, llmMode, LlmUnavailableError, RetryableError, savingConfig } from "./llm.ts";
import { similarity, tokens } from "./lib/text.ts";

export const SELECT_THRESHOLD = Number(process.env.SELECT_THRESHOLD || 60);
const RESCORE_BAND = 10;
const BATCH = 20;
/** 重要度低于这个分的，不写中文标题和摘要。 */
const WRITE_MIN_IMPORTANCE = 45;
/** 标题相似度到这个程度，就沿用已有判断（实测和模型自己判的结果一致 87%）。 */
const INHERIT_MIN_SIMILARITY = 0.7;
const MAX_ATTEMPTS = 3;
const RETRY_MINUTES = [2, 10, 30];

interface Row {
  id: number;
  topic: string;
  title: string;
  publisher: string | null;
  excerpt: string | null;
  source_id: string;
  first_party: number | null;
  timeline_at: number;
  published_at: number | null;
  backfill: number;
  attempts: number;
  discovered_at: number;
}

interface Judgment {
  relevant: boolean;
  topic: TopicKey | "none";
  importance: number;
  score2?: number | null;
  titleZh: string | null;
  summaryZh: string | null;
  entities: string[];
  eventRef: string | null;
  mode: "llm" | "rules" | "inherit";
}

// ── LLM 模式 ────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `你是一个市场新闻编辑，为"异动雷达"看板筛选新闻。看板盯四条主线：
- semis 半导体：英伟达、台积电、AMD、博通、阿斯麦、美光等芯片公司；出口管制、产能、订单与需求。
- ai AI 巨头：OpenAI、Anthropic、谷歌、微软、Meta、亚马逊等的模型发布、融资估值、算力开支、重大合作、监管。
- energy 石油与地缘：原油供需、OPEC、战争与冲突、制裁、航运要道、黄金避险。
- macro 宏观与大盘：美联储与利率、通胀和就业数据、关税与贸易政策、美股大盘和 VIX 波动。

对每条新闻给出：
1. relevant：属于以上任一主线、并且有实际的新信息。以下算不相关：荐股软文（"X 只值得买的股票"）、股价预测、没有新事实的观点和复盘、与四条主线无关的新闻、广告和活动预告。
2. topic：最贴切的一条主线；不相关填 none。
3. importance（0-100）：这件事对上面这些资产价格的潜在影响。
   90 以上：改变行业格局或引发大盘剧烈波动（重大出口禁令、战争升级或封锁航道、美联储意外转向、龙头公司业绩大幅偏离预期）。
   70-89：大公司的重大事件（财报、大额订单、重要产品、大额融资、监管处罚），或能明显推动油价、利率预期的数据和事件。
   50-69：有价值但影响有限的行业动态、重要评级变化、中等规模合作。
   30-49：常规动态、传闻、延续性报道。
   0-29：几乎没有增量信息。
   只依据给出的标题和摘要打分，不要因为公司有名就给高分；同一件事的跟进报道如果没有新事实，分数低于首发。
4. title_zh：中文标题，25 字以内，保留关键数字和公司名，不加入原文没有的信息。
   只给相关、且 importance ≥ ${WRITE_MIN_IMPORTANCE} 的新闻写；其余填空字符串 ""。
5. summary_zh：一句中文摘要，60 字以内，先说发生了什么，再说为什么重要。原文信息不够时只概括标题，不要编造。
   只给相关、且 importance ≥ ${SELECT_THRESHOLD} 的新闻写（只有这些会被展示）；其余填空字符串 ""。
   先定 importance，再按上面的分数线决定写不写——不写的条目能省很多输出。
6. entities：涉及的公司、国家、机构、人物，用英文规范名（如 "Nvidia"、"OpenAI"、"Iran"、"Federal Reserve"），最多 6 个。
7. event_ref：这条新闻属于哪个事件。
   - 和"近期事件"列表里某个事件是同一件现实中的事（包括它的直接后续报道）：填那个事件的编号，如 "E12"。
     同一家公司的不同消息不是同一件事（比如"OpenAI 发布新产品"和"OpenAI 调整订阅价格"是两个事件），只是主题相近也不算。
   - 否则是新事件：本批次里说同一件新事的几条新闻填同一个新编号 "N1"，其他新事件依次用 "N2"、"N3"。
   - 不相关的新闻填 "none"。`;

// 宽容一点：只有 JSON 模式的模型（DeepSeek）偶尔会把数字写成字符串、漏掉可选字段。
const JudgeSchema = z.object({
  items: z.array(z.object({
    id: z.coerce.number().int(),
    relevant: z.boolean(),
    topic: z.enum(["semis", "ai", "energy", "macro", "none"]).catch("none"),
    importance: z.coerce.number(),
    title_zh: z.string().catch(""),
    summary_zh: z.string().catch(""),
    entities: z.array(z.string()).catch([]),
    event_ref: z.string().catch("none"),
  })),
});

const JUDGE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "relevant", "topic", "importance", "title_zh", "summary_zh", "entities", "event_ref"],
        properties: {
          id: { type: "integer" },
          relevant: { type: "boolean" },
          topic: { type: "string", enum: ["semis", "ai", "energy", "macro", "none"] },
          importance: { type: "integer" },
          title_zh: { type: "string" },
          summary_zh: { type: "string" },
          entities: { type: "array", items: { type: "string" } },
          event_ref: { type: "string" },
        },
      },
    },
  },
};

const RESCORE_SYSTEM = `你是市场新闻的第二审稿人，只负责复核"重要度"。另一位编辑已经打过分，你看不到他的分数，请独立判断。
importance（0-100）= 这件事对美股大盘、半导体、AI 巨头、原油和黄金价格的潜在影响：
90 以上改变行业格局或引发大盘剧烈波动；70-89 大公司重大事件或能明显推动油价、利率预期的数据；50-69 有价值但影响有限；30-49 常规动态或传闻；0-29 几乎没有增量信息。
只依据给出的标题和摘要，不要因为公司有名就给高分。`;

const RescoreSchema = z.object({ items: z.array(z.object({ id: z.coerce.number().int(), importance: z.coerce.number() })) });
const RESCORE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "importance"], properties: { id: { type: "integer" }, importance: { type: "integer" } } } } },
};

const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "未知");
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function itemsText(rows: Row[]): string {
  return rows.map((r, i) => `[${i + 1}] ${r.title}\n    媒体：${r.publisher ?? "未知"}｜发布：${fmtTime(r.published_at)}${r.excerpt ? `\n    摘要：${r.excerpt.slice(0, 400)}` : ""}`).join("\n");
}

/**
 * 给模型看哪些"近期事件"：先按标题词汇相似度召回和这批新闻最像的（AIHOT 用向量召回，这里用词法），
 * 再补上最重要的几个。只给最重要的，相关的那个事件可能不在列表里，模型就会重复新建。
 */
function candidateEvents(rows: Row[]) {
  const pool = eventsNear(rows[0]!.timeline_at, 400);
  const mine = rows.map((r) => tokens(r.title));
  const scored = pool.map((e) => {
    const et = JSON.parse(e.tokens) as string[];
    return { e, sim: Math.max(...mine.map((t) => similarity(t, et))) };
  });
  const similar = scored.filter((s) => s.sim >= 0.12).sort((a, b) => b.sim - a.sim).slice(0, 35).map((s) => s.e);
  const picked = new Map(similar.map((e) => [e.id, e]));
  for (const e of pool) {
    if (picked.size >= 50) break;
    picked.set(e.id, e); // pool 已按重要度排序
  }
  return [...picked.values()];
}

async function judgeLlm(rows: Row[]): Promise<Map<number, Judgment>> {
  const recent = candidateEvents(rows);
  const eventsText = recent.length ? recent.map((e) => `E${e.id}: ${e.title_zh ?? e.title}`).join("\n") : "（暂无）";
  const out = await callJson({
    purpose: "judge",
    system: JUDGE_SYSTEM,
    user: `近期事件：\n${eventsText}\n\n待判断的新闻（共 ${rows.length} 条，id 用方括号里的序号）：\n${itemsText(rows)}`,
    schema: JUDGE_JSON_SCHEMA,
    validate: JudgeSchema,
  });
  const result = new Map<number, Judgment>();
  for (const it of out.items) {
    const row = rows[it.id - 1];
    if (!row) continue;
    const relevant = it.relevant && it.topic !== "none";
    result.set(row.id, {
      relevant, topic: relevant ? it.topic : "none", importance: clamp(it.importance),
      titleZh: it.title_zh.trim() || null, summaryZh: it.summary_zh.trim() || null,
      entities: it.entities.slice(0, 6), eventRef: relevant ? it.event_ref : null, mode: "llm",
    });
  }
  // 门槛附近的，再独立打一次分，取平均（设置里可以关掉）。
  const near = !savingConfig().rescore ? [] : rows.filter((r) => {
    const j = result.get(r.id);
    return j?.relevant && Math.abs(j.importance - SELECT_THRESHOLD) <= RESCORE_BAND;
  });
  if (near.length) {
    const second = await callJson({
      purpose: "rescore",
      system: RESCORE_SYSTEM,
      user: `请复核以下 ${near.length} 条新闻的重要度（id 用方括号里的序号）：\n${itemsText(near)}`,
      schema: RESCORE_JSON_SCHEMA,
      validate: RescoreSchema,
    });
    for (const it of second.items) {
      const row = near[it.id - 1];
      const j = row && result.get(row.id);
      if (j) j.score2 = clamp(it.importance);
    }
  }
  return result;
}

// ── 规则模式 ─────────────────────────────────────────────────────────────────

const STRONG = ["record", "plunge", "surge", "soar", "tumble", "slump", "ban", "export control", "sanction", "strike", "attack", "ceasefire", "blockade",
  "rate cut", "rate hike", "earnings", "guidance", "forecast", "acquire", "acquisition", "billion", "halt", "invasion", "crash", "rally", "selloff", "sell-off"];
const ENTITY_WORDS: Array<[string, string]> = [
  ...ASSETS.flatMap((a) => a.keywords.filter((k) => k.length > 3).map((k) => [k, a.name] as [string, string])),
  ["openai", "OpenAI"], ["anthropic", "Anthropic"], ["deepseek", "DeepSeek"], ["iran", "Iran"], ["israel", "Israel"], ["russia", "Russia"],
  ["ukraine", "Ukraine"], ["china", "China"], ["opec", "OPEC"], ["federal reserve", "Federal Reserve"], ["powell", "Federal Reserve"],
];

function judgeRules(r: Row): Judgment {
  const text = ` ${r.title} ${r.excerpt ?? ""} `.toLowerCase();
  let best: { key: TopicKey; hits: number } = { key: r.topic as TopicKey, hits: 0 };
  for (const t of TOPICS) {
    const hits = t.keywords.filter((k) => text.includes(k)).length;
    if (hits > best.hits || (hits === best.hits && hits > 0 && t.key === r.topic)) best = { key: t.key, hits };
  }
  const noise = NOISE_PATTERNS.some((p) => text.includes(p));
  const pub = (r.publisher ?? "").toLowerCase();
  const tier1 = TIER1_PUBLISHERS.some((p) => pub.includes(p));
  const strong = STRONG.filter((k) => text.includes(k)).length;
  const importance = clamp(30 + 8 * Math.min(best.hits, 3) + (tier1 ? 12 : 0) + (r.first_party ? 10 : 0) + 8 * Math.min(strong, 2) - (noise ? 35 : 0));
  const relevant = best.hits > 0 && !noise;
  const entities = [...new Set(ENTITY_WORDS.filter(([k]) => text.includes(k)).map(([, name]) => name))].slice(0, 6);
  return { relevant, topic: relevant ? best.key : "none", importance, titleZh: null, summaryZh: null, entities, eventRef: null, mode: "rules" };
}

// ── 写回 ─────────────────────────────────────────────────────────────────────

function apply(rows: Row[], judgments: Map<number, Judgment>) {
  const newGroups = new Map<string, number>();
  const known = new Set(eventsNear(rows[0]!.timeline_at, 400).map((e) => e.id));
  for (const r of rows) {
    const j = judgments.get(r.id);
    if (!j) continue;
    const final = j.score2 != null ? Math.round((j.importance + j.score2) / 2) : j.importance;
    const selected = j.relevant && final >= SELECT_THRESHOLD;
    run(`UPDATE articles SET state = 'judged', mode = ?, relevant = ?, topic = ?, importance = ?, score1 = ?, score2 = ?, selected = ?,
           title_zh = ?, summary_zh = ?, entities = ?, judged_at = ?, error = NULL, retry_at = NULL WHERE id = ?`,
      j.mode, j.relevant ? 1 : 0, j.topic === "none" ? r.topic : j.topic, final, j.importance, j.score2 ?? null, selected ? 1 : 0,
      j.titleZh, j.summaryZh, JSON.stringify(j.entities), Date.now(), r.id);
    if (!j.relevant) continue;
    const a: ArticleForEvent = { id: r.id, topic: j.topic, title: r.title, title_zh: j.titleZh, importance: final, entities: j.entities, timeline_at: r.timeline_at };
    const ref = j.eventRef ?? "";
    const existing = /^E(\d+)$/.exec(ref);
    if (existing && known.has(Number(existing[1]))) joinEvent(Number(existing[1]), a);
    else if (/^N\d+$/.test(ref)) {
      const g = newGroups.get(ref);
      if (g) joinEvent(g, a);
      else newGroups.set(ref, createEvent(a));
    } else assignLexical(a); // 规则模式，或 LLM 给了列表里没有的编号
  }
}

function markRetry(rows: Row[], message: string, delayMs?: number) {
  for (const r of rows) {
    const attempts = r.attempts + 1;
    if (delayMs === undefined && attempts >= MAX_ATTEMPTS) {
      // 反复失败：退回规则模式判断，不让一条资料卡死在队列里。
      apply([r], new Map([[r.id, judgeRules(r)]]));
      run("UPDATE articles SET error = ?, attempts = ? WHERE id = ?", `LLM 失败 ${attempts} 次，改用规则：${message}`.slice(0, 500), attempts, r.id);
      continue;
    }
    const wait = delayMs ?? RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)]! * 60_000;
    run("UPDATE articles SET attempts = ?, retry_at = ?, error = ? WHERE id = ?", delayMs === undefined ? attempts : r.attempts, Date.now() + wait, message.slice(0, 500), r.id);
  }
}

const SELECT_ROWS = `SELECT a.id, a.topic, a.title, a.publisher, a.excerpt, a.source_id, s.first_party, a.timeline_at, a.published_at, a.backfill, a.attempts, a.discovered_at
  FROM articles a LEFT JOIN sources s ON s.id = a.source_id`;

// ── 沿用：同一件事的其他报道，标题几乎一样，直接沿用已经判过的结果 ────────────────

interface Parent {
  tk: string[];
  relevant: boolean;
  topic: TopicKey;
  importance: number;
  titleZh: string | null;
  summaryZh: string | null;
  entities: string[];
  eventId: number | null;
}

function loadParents(where: string, ...params: Array<number>): Parent[] {
  return all<{ title: string; relevant: number; topic: TopicKey; importance: number; title_zh: string | null; summary_zh: string | null; entities: string | null; event_id: number | null }>(
    `SELECT title, relevant, topic, importance, title_zh, summary_zh, entities, event_id FROM articles WHERE mode = 'llm' AND ${where}`, ...params,
  ).map((p) => ({
    tk: tokens(p.title), relevant: !!p.relevant, topic: p.topic, importance: p.importance, titleZh: p.title_zh, summaryZh: p.summary_zh,
    entities: p.entities ? (JSON.parse(p.entities) as string[]) : [], eventId: p.event_id,
  }));
}

function findParent(parents: Parent[], tk: string[]): Parent | null {
  let best: Parent | null = null;
  let bestSim = 0;
  for (const p of parents) {
    const s = similarity(tk, p.tk);
    if (s > bestSim) {
      bestSim = s;
      best = p;
    }
  }
  return bestSim >= INHERIT_MIN_SIMILARITY ? best : null;
}

const inherited = (p: Parent): Judgment => ({
  relevant: p.relevant, topic: p.relevant ? p.topic : "none", importance: p.importance, score2: null,
  titleZh: p.titleZh, summaryZh: p.summaryZh, entities: p.entities, eventRef: p.eventId ? `E${p.eventId}` : null, mode: "inherit",
});

// ── 队列 ─────────────────────────────────────────────────────────────────────

export interface QueueStats { judged: number; llm: number; inherited: number; rules: number; waiting: number }

/**
 * 处理等待判断的资料。先分流，能不调模型的都不调：
 *   规则：没配模型 / 今日花费到上限；荐股软文；历史回溯的旧闻；按需模式下已经过时的（没人看的时候进来、现在超过 catchUpHours）
 *   排队：按需模式下没人在看
 *   沿用：和刚判过的报道标题几乎一样
 *   模型：剩下的，20 条一批
 */
export async function processQueue(limit = 100, onlyIds?: number[]): Promise<QueueStats> {
  const rows = onlyIds
    ? all<Row>(`${SELECT_ROWS} WHERE a.state = 'new' AND a.id IN (${onlyIds.map(() => "?").join(",") || "0"})`, ...onlyIds)
    : all<Row>(`${SELECT_ROWS} WHERE a.state = 'new' AND (a.retry_at IS NULL OR a.retry_at <= ?) ORDER BY a.backfill, a.discovered_at DESC LIMIT ?`, Date.now(), limit);
  const stats: QueueStats = { judged: 0, llm: 0, inherited: 0, rules: 0, waiting: 0 };
  const saving = savingConfig();
  const { mode } = llmMode();
  const staleBefore = Date.now() - saving.catchUpHours * 3600_000;

  const byRules: Row[] = [];
  let queue: Row[] = [];
  for (const r of rows) {
    const text = ` ${r.title} ${r.excerpt ?? ""} `.toLowerCase();
    const noise = NOISE_PATTERNS.some((p) => text.includes(p));
    const stale = saving.onDemand && r.discovered_at < staleBefore;
    if (mode === "rules" || r.backfill || noise || stale) byRules.push(r);
    else if (mode === "wait") stats.waiting++;
    else queue.push(r);
  }
  if (byRules.length) {
    apply(byRules, new Map(byRules.map((r) => [r.id, judgeRules(r)])));
    stats.judged += byRules.length;
    stats.rules += byRules.length;
  }
  if (!queue.length) return stats;

  const parents = saving.inherit ? loadParents("timeline_at > ?", Date.now() - 48 * 3600_000) : [];
  const tk = new Map(queue.map((r) => [r.id, tokens(r.title)]));
  let llmOn = true;
  let paused: BudgetExceededError | null = null;
  while (queue.length) {
    // 1. 能沿用的直接沿用
    if (saving.inherit) {
      const rest: Row[] = [];
      for (const r of queue) {
        const p = findParent(parents, tk.get(r.id)!);
        if (p) {
          apply([r], new Map([[r.id, inherited(p)]]));
          stats.judged++;
          stats.inherited++;
        } else rest.push(r);
      }
      queue = rest;
      if (!queue.length) break;
    }
    // 2. 组一批。同一批里标题几乎一样的只送一条，其余等这批判完再沿用。
    const chunk: Row[] = [];
    const deferred: Row[] = [];
    for (const r of queue) {
      const twin = saving.inherit && chunk.some((c) => similarity(tk.get(c.id)!, tk.get(r.id)!) >= INHERIT_MIN_SIMILARITY);
      if (chunk.length >= BATCH || twin) deferred.push(r);
      else chunk.push(r);
    }
    queue = deferred;
    if (paused) {
      // 预算窗口满了：排队等下一个窗口，不要用规则模式把它们永久判掉。
      markRetry(chunk, paused.message, paused.retryAfterMs);
      stats.waiting += chunk.length;
      continue;
    }
    if (llmOn) {
      try {
        const judged = await judgeLlm(chunk);
        apply(chunk, judged);
        // 模型漏掉的条目：排队重试，反复漏掉就退回规则模式。
        const missed = chunk.filter((r) => !judged.has(r.id));
        if (missed.length) markRetry(missed, "模型输出里漏掉了这条");
        stats.judged += chunk.length - missed.length;
        stats.llm += chunk.length - missed.length;
        stats.waiting += missed.length;
        // 刚判完的也能被后面的沿用
        if (saving.inherit) parents.push(...loadParents(`id IN (${chunk.map((r) => r.id).join(",")})`));
        continue;
      } catch (error) {
        if (error instanceof BudgetExceededError) {
          paused = error;
          markRetry(chunk, error.message, error.retryAfterMs);
          stats.waiting += chunk.length;
          continue;
        }
        if (!(error instanceof LlmUnavailableError)) {
          markRetry(chunk, String(error instanceof Error ? error.message : error), error instanceof RetryableError ? 60_000 : undefined);
          stats.waiting += chunk.length;
          continue;
        }
        llmOn = false; // 凭证失效：这批和之后都走规则模式
      }
    }
    apply(chunk, new Map(chunk.map((r) => [r.id, judgeRules(r)])));
    stats.judged += chunk.length;
    stats.rules += chunk.length;
  }
  return stats;
}
