// 盯盘标的。OpenAI、Anthropic 没上市，用关联上市公司当代理：
// 微软是 OpenAI 的主要股东，亚马逊和谷歌是 Anthropic 的主要投资方。
import type { TopicKey } from "./topics.ts";

export type Feed =
  | { p: "nasdaq"; sym: string; cls: "stocks" | "etf" | "index" }
  /** Cboe 官网公开的指数日线 CSV（免费，全历史，通常到前一交易日收盘）。cnn 为 CNN 恐慌贪婪数据里的同一序列，用来补当天的盘中值。 */
  | { p: "cboe"; file: "SPX" | "VIX"; cnn?: string }
  /** FRED 官方序列（有 1 天到 1 周的发布延迟；部分机房的 IP 会被它的 CDN 屏蔽）。 */
  | { p: "fred"; id: string; cnn?: string };

export interface AssetSpec {
  symbol: string;
  name: string;
  group: "market" | "semis" | "ai" | "energy";
  /** 异动归因时，在哪些主线里找候选事件。 */
  topics: TopicKey[];
  /** 新闻里出现这些词，说明和这个标的直接相关（小写）。 */
  keywords: string[];
  /** 回溯历史异动时用的 Google News 搜索词。 */
  newsQuery: string;
  feed: Feed;
  note?: string;
}

const ALL: TopicKey[] = ["macro", "semis", "ai", "energy"];

export const ASSETS: AssetSpec[] = [
  // 大盘与情绪
  { symbol: "SPX", name: "标普 500", group: "market", topics: ALL, keywords: ["s&p", "stocks", "wall street", "stock market"], newsQuery: "stock market", feed: { p: "cboe", file: "SPX", cnn: "market_momentum_sp500" } },
  { symbol: "COMP", name: "纳斯达克", group: "market", topics: ALL, keywords: ["nasdaq", "tech stocks", "stocks", "wall street"], newsQuery: "Nasdaq tech stocks", feed: { p: "nasdaq", sym: "COMP", cls: "index" } },
  { symbol: "VIX", name: "VIX 恐慌", group: "market", topics: ALL, keywords: ["vix", "volatility", "selloff", "sell-off", "fear", "plunge", "rout"], newsQuery: "stock market selloff volatility", feed: { p: "cboe", file: "VIX", cnn: "market_volatility_vix" } },
  // 半导体
  { symbol: "SOX", name: "费城半导体", group: "semis", topics: ["semis", "ai", "macro"], keywords: ["semiconductor", "chip", "chipmaker"], newsQuery: "chip stocks", feed: { p: "nasdaq", sym: "SOX", cls: "index" } },
  { symbol: "NVDA", name: "英伟达", group: "semis", topics: ["semis", "ai", "macro"], keywords: ["nvidia", "nvda", "jensen huang", "blackwell", "rubin"], newsQuery: "Nvidia stock", feed: { p: "nasdaq", sym: "NVDA", cls: "stocks" } },
  { symbol: "TSM", name: "台积电", group: "semis", topics: ["semis", "ai", "macro", "energy"], keywords: ["tsmc", "taiwan semiconductor"], newsQuery: "TSMC stock", feed: { p: "nasdaq", sym: "TSM", cls: "stocks" } },
  { symbol: "AMD", name: "AMD", group: "semis", topics: ["semis", "ai", "macro"], keywords: ["amd", "advanced micro", "lisa su"], newsQuery: "AMD stock", feed: { p: "nasdaq", sym: "AMD", cls: "stocks" } },
  { symbol: "AVGO", name: "博通", group: "semis", topics: ["semis", "ai", "macro"], keywords: ["broadcom", "avgo"], newsQuery: "Broadcom stock", feed: { p: "nasdaq", sym: "AVGO", cls: "stocks" } },
  { symbol: "ASML", name: "阿斯麦", group: "semis", topics: ["semis", "macro"], keywords: ["asml", "lithography"], newsQuery: "ASML stock", feed: { p: "nasdaq", sym: "ASML", cls: "stocks" } },
  { symbol: "MU", name: "美光", group: "semis", topics: ["semis", "ai", "macro"], keywords: ["micron", "hbm", "memory chip", "dram"], newsQuery: "Micron stock", feed: { p: "nasdaq", sym: "MU", cls: "stocks" } },
  // AI 巨头（及 OpenAI / Anthropic 的上市代理）
  { symbol: "MSFT", name: "微软", group: "ai", topics: ["ai", "macro"], keywords: ["microsoft", "azure", "openai", "nadella", "copilot"], newsQuery: "Microsoft stock", feed: { p: "nasdaq", sym: "MSFT", cls: "stocks" }, note: "OpenAI 主要股东" },
  { symbol: "GOOGL", name: "谷歌", group: "ai", topics: ["ai", "macro"], keywords: ["google", "alphabet", "gemini", "deepmind", "anthropic"], newsQuery: "Alphabet stock", feed: { p: "nasdaq", sym: "GOOGL", cls: "stocks" }, note: "Anthropic 投资方" },
  { symbol: "AMZN", name: "亚马逊", group: "ai", topics: ["ai", "macro"], keywords: ["amazon", "aws", "anthropic", "jassy"], newsQuery: "Amazon stock", feed: { p: "nasdaq", sym: "AMZN", cls: "stocks" }, note: "Anthropic 主要投资方" },
  { symbol: "META", name: "Meta", group: "ai", topics: ["ai", "macro"], keywords: ["meta platforms", "meta's", "zuckerberg", "llama", "facebook"], newsQuery: "Meta stock", feed: { p: "nasdaq", sym: "META", cls: "stocks" } },
  // 石油、地缘与避险
  { symbol: "USO", name: "WTI 原油", group: "energy", topics: ["energy", "macro"], keywords: ["oil", "crude", "wti", "opec", "hormuz", "iran", "refinery"], newsQuery: "oil prices", feed: { p: "nasdaq", sym: "USO", cls: "etf" }, note: "USO ETF，跟踪 WTI 原油期货" },
  { symbol: "BNO", name: "布伦特原油", group: "energy", topics: ["energy", "macro"], keywords: ["oil", "crude", "brent", "opec", "hormuz", "iran", "russia"], newsQuery: "Brent crude oil", feed: { p: "nasdaq", sym: "BNO", cls: "etf" }, note: "BNO ETF，跟踪布伦特原油期货" },
  { symbol: "GLD", name: "黄金", group: "energy", topics: ["energy", "macro"], keywords: ["gold", "safe haven", "safe-haven", "bullion"], newsQuery: "gold prices", feed: { p: "nasdaq", sym: "GLD", cls: "etf" }, note: "GLD 黄金 ETF" },
];

/** 只展示水平、不做异动检测的官方现货价（FRED，发布有延迟）。 */
export const LEVELS = [
  { symbol: "WTI_SPOT", name: "WTI 现货", fredId: "DCOILWTICO" },
  { symbol: "BRENT_SPOT", name: "布伦特现货", fredId: "DCOILBRENTEU" },
];

export const GROUP_NAMES: Record<AssetSpec["group"], string> = { market: "大盘情绪", semis: "半导体", ai: "AI 巨头", energy: "能源与避险" };
export const assetBySymbol = (s: string) => ASSETS.find((a) => a.symbol === s);
