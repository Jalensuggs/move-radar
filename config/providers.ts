// 可以在页面上选的模型服务商。除了 Claude，其余都走 OpenAI 兼容的 /chat/completions。
// 价格是每百万 token 的美元价，只用于花费统计和"每日花费上限"；留空表示不知道（上限按调用次数兜底）。
export type PresetKey = "deepseek" | "qwen" | "zhipu" | "moonshot" | "openai" | "anthropic" | "custom" | "off";

export interface Preset {
  key: PresetKey;
  name: string;
  kind: "openai" | "anthropic" | "off";
  baseUrl: string;
  model: string;
  /** [输入, 输出, 命中缓存的输入]，$/百万 token */
  price: [number, number, number] | null;
  /** 服务商特有的请求参数，比如关掉思考模式（分类和写摘要不需要长思考，关掉更快更便宜）。 */
  extraBody: Record<string, unknown>;
  keyUrl: string;
  hint: string;
}

export const PRESETS: Preset[] = [
  {
    key: "deepseek", name: "DeepSeek", kind: "openai", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    price: [0.3, 1.2, 0.006], extraBody: { thinking: { type: "disabled" } },
    keyUrl: "https://platform.deepseek.com/api_keys", hint: "最便宜。价格按高峰时段估，低峰时段（北京时间晚上和周末）半价。",
  },
  {
    key: "qwen", name: "通义千问（阿里云百炼）", kind: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.8-flash",
    price: null, extraBody: { enable_thinking: false },
    keyUrl: "https://bailian.console.aliyun.com/", hint: "价格请到百炼控制台查，填在下面才能统计花费。",
  },
  {
    key: "zhipu", name: "智谱 GLM", kind: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-5.3-flash",
    price: null, extraBody: {},
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys", hint: "价格请到智谱开放平台查。",
  },
  {
    key: "moonshot", name: "Kimi（月之暗面）", kind: "openai", baseUrl: "https://api.moonshot.cn/v1", model: "",
    price: null, extraBody: {},
    keyUrl: "https://platform.moonshot.cn/console/api-keys", hint: "填好 Key 后点「获取模型列表」选一个。",
  },
  {
    key: "openai", name: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "",
    price: null, extraBody: {},
    keyUrl: "https://platform.openai.com/api-keys", hint: "填好 Key 后点「获取模型列表」选一个。",
  },
  {
    key: "anthropic", name: "Claude（Anthropic）", kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5",
    price: [4, 20, 0.2], extraBody: {},
    keyUrl: "https://console.anthropic.com/settings/keys", hint: "输出格式由 API 保证。更便宜的可选 claude-sonnet-5-5（$2/$10）或 claude-haiku-4-5（$1/$5）。",
  },
  {
    key: "custom", name: "自定义（OpenAI 兼容接口）", kind: "openai", baseUrl: "", model: "",
    price: null, extraBody: {},
    keyUrl: "", hint: "任何兼容 OpenAI /chat/completions 的服务，包括本地的 Ollama（http://localhost:11434/v1）。",
  },
  {
    key: "off", name: "不用模型（规则模式）", kind: "off", baseUrl: "", model: "",
    price: null, extraBody: {},
    keyUrl: "", hint: "完全免费：关键词打分 + 词法聚簇，没有中文标题。",
  },
];

export const presetOf = (k: string) => PRESETS.find((p) => p.key === k) ?? PRESETS.at(-1)!;
