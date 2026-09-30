// 调度：每分钟一轮。抓到期的信源 → 判断新资料 → 行情（每 20 分钟）→ 检测异动 → 自动归因。
// 每一步单独记录运行结果，一步失败不影响后面的步骤。
import { getKv, recordRun, run } from "./db.ts";
import { adaptIntervals, collectDue, seedSources } from "./collect/news.ts";
import { refreshMarket } from "./collect/market.ts";
import { processQueue } from "./judge.ts";
import { attributePending, detectMoves } from "./moves.ts";
import { llmMode } from "./llm.ts";

const TICK_MS = 60_000;
const MARKET_EVERY_MS = 20 * 60_000;

let running = false;

export async function tick(opts: { forceMarket?: boolean } = {}) {
  if (running) return; // 上一轮还没跑完就跳过，不叠加
  running = true;
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await recordRun(name, fn as () => Promise<unknown>);
    } catch (error) {
      console.error(`[${name}]`, error instanceof Error ? error.message : error);
    }
  };
  try {
    await step("news.collect", () => collectDue());
    // 调模型时每轮最多 100 条（约 5 次批量调用）；规则模式和排队不花钱，一次过完。
    await step("news.judge", () => processQueue(llmMode().mode === "llm" ? 100 : 5000));
    const last = getKv<number>("market_refreshed_at")?.value ?? 0;
    if (opts.forceMarket || Date.now() - last > MARKET_EVERY_MS) {
      await step("market.refresh", () => refreshMarket());
      await step("moves.detect", async () => detectMoves());
    }
    await step("moves.attribute", () => attributePending(3));
    await step("sources.adapt", async () => adaptIntervals());
    // 运行记录只留最近 3 天
    run("DELETE FROM runs WHERE started_at < ?", Date.now() - 3 * 86400_000);
  } finally {
    running = false;
  }
}

export function startWorker() {
  seedSources();
  void tick({ forceMarket: true });
  return setInterval(() => void tick(), TICK_MS);
}
