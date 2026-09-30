// 信源：Google News 搜索（免费、可按日期回溯）+ 几个官方一手 RSS。
// intervalMin 是初始抓取间隔，之后按产出自动调整（src/collect/schedule.ts）。
import type { TopicKey } from "./topics.ts";

export interface SourceSeed {
  id: string;
  name: string;
  kind: "gnews" | "rss";
  topic: TopicKey;
  /** gnews: 搜索词；rss: feed 地址 */
  target: string;
  intervalMin: number;
  firstParty?: boolean;
}

const g = (id: string, topic: TopicKey, query: string, intervalMin = 20): SourceSeed => ({
  id: `gn-${id}`, name: `Google News · ${query}`, kind: "gnews", topic, target: query, intervalMin,
});

export const SOURCES: SourceSeed[] = [
  // 半导体
  g("nvidia", "semis", "Nvidia", 15),
  g("tsmc", "semis", "TSMC OR \"Taiwan Semiconductor\""),
  g("chip-stocks", "semis", "semiconductor stocks"),
  g("export-controls", "semis", "chip export controls", 30),
  g("chipmakers", "semis", "AMD OR Broadcom OR Micron OR ASML"),
  // AI 巨头
  g("openai", "ai", "OpenAI", 15),
  g("anthropic", "ai", "Anthropic Claude", 15),
  g("ai-capex", "ai", "AI data center spending", 30),
  g("bigtech-ai", "ai", "Microsoft OR Google OR Meta AI model"),
  // 石油与地缘
  g("oil", "energy", "oil prices", 15),
  g("opec", "energy", "OPEC", 30),
  g("hormuz", "energy", "Iran Israel OR \"Strait of Hormuz\"", 15),
  g("russia-ukraine", "energy", "Russia Ukraine war", 30),
  // 宏观与大盘
  g("markets", "macro", "stock market today", 15),
  g("fed", "macro", "Federal Reserve interest rates", 20),
  g("vix", "macro", "VIX volatility stocks", 30),
  g("tariffs", "macro", "tariffs stocks", 30),
  g("inflation", "macro", "inflation CPI", 60),
  // 官方一手
  { id: "rss-openai", name: "OpenAI News", kind: "rss", topic: "ai", target: "https://openai.com/news/rss.xml", intervalMin: 30, firstParty: true },
  { id: "rss-nvidia", name: "NVIDIA Newsroom", kind: "rss", topic: "semis", target: "https://nvidianews.nvidia.com/releases.xml", intervalMin: 60, firstParty: true },
  { id: "rss-fed", name: "Federal Reserve", kind: "rss", topic: "macro", target: "https://www.federalreserve.gov/feeds/press_all.xml", intervalMin: 60, firstParty: true },
];
