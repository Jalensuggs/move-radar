// 归因评测：拿人工标注过"真实原因"的历史异动，跑一遍归因，算 top-1 / top-3 命中率。
// 每改一次提示词、换一次模型、调一次打分公式，就重跑一次，把结果存进 eval/results/ 对比。
//
//   npm run eval                 # 用 eval/labels.jsonl
//   npm run eval -- my.jsonl     # 用别的标注文件
//
// 标注格式（一行一条）：{"symbol":"NVDA","date":"2025-01-27","cause":"人话描述","keywords":["deepseek"]}
// keywords 命中候选事件的标题（英文原标题或中文标题，不分大小写）任意一个就算对。
// cause 写 "none" 表示当天没有明确新闻（比如纯大盘跟随），这时"没有选出主因"才算对。
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get } from "../src/db.ts";
import { refreshMarket } from "../src/collect/market.ts";
import { attributeMove, type Candidate } from "../src/moves.ts";
import { llmStatus, costToday, markViewer } from "../src/llm.ts";

interface Label { symbol: string; date: string; cause: string; keywords: string[] }

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? path.join(here, "labels.jsonl");
const labels: Label[] = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Label);

// 评测是有人主动要跑的，不受"没人在看就暂停模型"的限制。
markViewer();

if (!get("SELECT 1 FROM prices LIMIT 1")) {
  console.log("还没有行情数据，先拉一次……");
  await refreshMarket();
}

const hit = (c: Candidate | null | undefined, keywords: string[]) =>
  !!c && keywords.some((k) => `${c.titleOriginal} ${c.title}`.toLowerCase().includes(k.toLowerCase()));

const costBefore = costToday().usd;
const rows: Array<Record<string, unknown>> = [];
let top1 = 0;
let top3 = 0;
let scored = 0;
for (const l of labels) {
  const a = await attributeMove(l.symbol, l.date);
  if (!a) {
    console.log(`- ${l.symbol} ${l.date}：没有这天的行情，跳过`);
    continue;
  }
  scored++;
  let ok1: boolean;
  let ok3: boolean;
  if (l.cause === "none") {
    ok1 = ok3 = a.primary === null;
  } else {
    // top-3：主因 + 次要因素 + 候选里排前面的，去重后取前三。
    const ranked: Candidate[] = [];
    for (const c of [a.primary, ...a.supporting, ...a.candidates]) if (c && !ranked.some((r) => r.url === c.url)) ranked.push(c);
    ok1 = hit(a.primary, l.keywords);
    ok3 = ranked.slice(0, 3).some((c) => hit(c, l.keywords));
  }
  top1 += ok1 ? 1 : 0;
  top3 += ok3 ? 1 : 0;
  rows.push({ ...l, mode: a.mode, ok1, ok3, primary: a.primary?.titleOriginal ?? null, confidence: a.confidence, newsCount: a.newsCount, explanation: a.explanation });
  console.log(`${ok1 ? "✓" : ok3 ? "~" : "✗"} ${l.symbol.padEnd(5)} ${l.date}  ${l.cause}\n    → ${a.primary?.titleOriginal ?? "（没有选出主因）"}`);
}

const llm = llmStatus();
const summary = {
  at: new Date().toISOString(),
  mode: llm.mode === "llm" ? `llm:${llm.model}` : "rules",
  labels: file,
  n: scored,
  top1: scored ? top1 / scored : 0,
  top3: scored ? top3 / scored : 0,
  costUsd: Math.round((costToday().usd - costBefore) * 1000) / 1000,
};
console.log(`\n${summary.mode}：${scored} 条，top-1 ${(summary.top1 * 100).toFixed(0)}%，top-3 ${(summary.top3 * 100).toFixed(0)}%，本次花费 $${summary.costUsd}`);
mkdirSync(path.join(here, "results"), { recursive: true });
const out = path.join(here, "results", `${summary.at.replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));
console.log(`结果：${path.relative(process.cwd(), out)}`);
