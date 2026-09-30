// 四条主线。keywords 用于规则模式下的相关性判断（小写，子串匹配）。
export type TopicKey = "semis" | "ai" | "energy" | "macro";

export interface Topic {
  key: TopicKey;
  name: string;
  keywords: string[];
}

export const TOPICS: Topic[] = [
  {
    key: "semis",
    name: "半导体",
    keywords: ["semiconductor", "chip", "nvidia", "tsmc", "taiwan semiconductor", "amd", "broadcom", "micron", "asml", "intel",
      "qualcomm", "arm holdings", "sk hynix", "samsung electronics", "hbm", "foundry", "export control", "gpu", "wafer", "lithography"],
  },
  {
    key: "ai",
    name: "AI 巨头",
    keywords: ["openai", "anthropic", "claude", "chatgpt", "gpt-", "gemini", "deepmind", "microsoft", "google", "alphabet", "meta ",
      "amazon", "aws", "artificial intelligence", " ai ", "ai model", "data center", "datacenter", "hyperscaler", "sam altman", "stargate", "xai", "deepseek"],
  },
  {
    key: "energy",
    name: "石油与地缘",
    keywords: ["oil", "crude", "brent", "wti", "opec", "gasoline", "natural gas", "lng", "hormuz", "iran", "israel", "russia", "ukraine",
      "war", "missile", "strike", "sanction", "ceasefire", "military", "taiwan strait", "red sea", "houthi", "gold price"],
  },
  {
    key: "macro",
    name: "宏观与大盘",
    keywords: ["s&p 500", "s&p500", "nasdaq", "dow jones", "wall street", "stock market", "stocks", "vix", "volatility", "fear", "federal reserve",
      "fed ", "powell", "rate cut", "rate hike", "interest rate", "inflation", "cpi", "jobs report", "payrolls", "treasury", "yield", "tariff", "recession", "gdp"],
  },
];

export const TOPIC_KEYS = TOPICS.map((t) => t.key);
export const topicName = (k: string) => TOPICS.find((t) => t.key === k)?.name ?? k;

/** 一手/头部媒体：规则模式下加分，也用于热度展示。 */
export const TIER1_PUBLISHERS = [
  "reuters", "bloomberg", "the wall street journal", "wsj", "financial times", "cnbc", "associated press", "ap news", "the new york times",
  "the information", "nikkei", "barron's", "marketwatch", "the economist", "axios", "techcrunch", "the verge", "semianalysis", "federal reserve",
  "openai", "nvidia", "anthropic",
];

/** 典型噪声：荐股软文、预测类、标题党。规则模式下扣分；LLM 模式下写进提示词。 */
export const NOISE_PATTERNS = [
  "stocks to buy", "stock to buy", "should you buy", "is it too late", "prediction:", "better buy", "motley fool", "zacks", "could make you",
  "millionaire", "no-brainer", "forever stock", "top pick", "what to watch", "live updates",
];
