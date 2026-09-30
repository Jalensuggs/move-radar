// 导出静态快照，给 GitHub Pages 用：npm run export:site
// 把当前数据库里的公开内容（行情、新闻、事件、异动归因）写成 docs/snapshot/*.json，
// 并把 web/ 下的页面复制到 docs/。页面在静态模式下读这些 JSON，不需要后端。
//
// 只导出公开内容：不碰 API Key、设置、回执、运行记录（那些在 kv / receipts / runs 表里，这里不读）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allAssets } from "../assets.ts";
import { TOPICS } from "../../config/topics.ts";
import { all } from "../db.ts";
import { hotEvents } from "../events.ts";
import { series } from "../collect/market.ts";
import { moveSummary, overview } from "../server.ts";
import type { MoveRow } from "../moves.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = process.env.EXPORT_DIR ? path.resolve(process.env.EXPORT_DIR) : path.join(root, "docs"); // EXPORT_DIR 只用来测试导出，平时不用设
const snap = path.join(out, "snapshot");

rmSync(snap, { recursive: true, force: true });
mkdirSync(snap, { recursive: true });
const write = (name: string, data: unknown) => writeFileSync(path.join(snap, name), JSON.stringify(data));

// 概览：去掉模型配置、花费、预算这些和访客无关（也不该公开）的字段。
const o = overview();
write("overview.json", {
  ...o,
  llm: { enabled: false, provider: null, model: null, source: "none", mode: "static", reason: "静态快照", saving: { dailyCapUsd: 0 }, budget: null },
  cost: { usd: 0, calls: 0 },
  usage: { llm: 0, inherit: 0, rules: 0 },
  stats: { ...o.stats, pending: 0 },
  static: { generatedAt: Date.now() },
});

// 热点：全部 + 四条主线
for (const key of ["", ...TOPICS.map((t) => t.key)]) write(`hot-${key || "all"}.json`, { events: hotEvents({ topic: key || null, limit: 15 }) });

// 每个标的的走势、异动，以及已经归因的异动的详情
let details = 0;
const safe = (s: string) => s.replace(/[^\w.-]/g, "_"); // 页面的 snapshotPath 用同一个规则
const assets = allAssets();
for (const a of assets) {
  const rows = all<MoveRow>("SELECT * FROM moves WHERE symbol = ? ORDER BY date", a.symbol);
  write(`chart-${safe(a.symbol)}.json`, {
    asset: { symbol: a.symbol, name: a.name, note: a.note ?? null, group: a.group },
    series: series(a.symbol, 520),
    moves: rows.map(moveSummary),
  });
  for (const m of rows) {
    if (!m.attribution) continue;
    write(`move-${safe(a.symbol)}-${m.date}.json`, { move: moveSummary(m), attribution: JSON.parse(m.attribution) });
    details++;
  }
}

// 最近 30 天异动
const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
write("moves.json", { moves: all<MoveRow>("SELECT * FROM moves WHERE date >= ? AND forced = 0 ORDER BY date DESC, abs(z) DESC LIMIT 60", since).map(moveSummary) });

// 页面：复制 web/，插入"静态模式"开关；图表库从 node_modules 复制，不依赖 CDN。
const html = readFileSync(path.join(root, "web", "index.html"), "utf8");
const marker = '<script src="app.js"></script>';
if (!html.includes(marker)) throw new Error("web/index.html 里找不到 app.js 的引用，导出脚本要跟着改");
writeFileSync(path.join(out, "index.html"), html.replace(marker, `<script>window.STATIC_SNAPSHOT = true;</script>\n  ${marker}`));
for (const f of ["app.js", "style.css"]) cpSync(path.join(root, "web", f), path.join(out, f));
mkdirSync(path.join(out, "vendor"), { recursive: true });
cpSync(path.join(root, "node_modules", "echarts", "dist", "echarts.min.js"), path.join(out, "vendor", "echarts.min.js"));
writeFileSync(path.join(out, ".nojekyll"), ""); // 不让 GitHub 用 Jekyll 处理这些文件

const count = all<{ n: number }>("SELECT count(*) AS n FROM articles WHERE selected = 1")[0]!.n;
console.log(`导出到 ${path.relative(root, out)}/：${assets.length} 个标的走势，${details} 条异动归因，${count} 条精选新闻在库`);
if (!existsSync(path.join(out, "screenshot.jpg"))) console.log("提示：docs/screenshot.jpg 不存在，README 里的截图会裂");
