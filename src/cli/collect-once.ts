// 跑一轮完整流程然后退出，方便调试：npm run collect
import { seedSources } from "../collect/news.ts";
import { tick } from "../worker.ts";
import { all } from "../db.ts";

seedSources();
const started = Date.now();
await tick({ forceMarket: true });
const runs = all<{ job: string; status: string; detail: string }>(
  "SELECT job, status, detail FROM runs WHERE started_at >= ? ORDER BY id", started);
for (const r of runs) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.job.padEnd(16)} ${r.detail?.slice(0, 300)}`);
console.log(`用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
