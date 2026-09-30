// 模型调用的唯一出口：回执（花过的钱不再花）、预算熔断、JSON 输出、错误分类，以及"什么时候不该调"。
//
// 用哪家：页面「AI 设置」里保存的配置优先；没保存过就看 .env（DEEPSEEK_API_KEY / ANTHROPIC_API_KEY）；都没有就是规则模式。
// 什么时候不调：
//   - 按需模式（默认开）：最近 idleMinutes 分钟没人打开看板，就暂停模型，新闻先排队；有人回来再处理，
//     太旧的（超过 catchUpHours）直接用规则判断——没人看的时候花钱写的中文摘要，没人读。
//   - 每日花费上限：今天花到上限，剩下的时间改用规则模式。
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { PRESETS, presetOf, type PresetKey } from "../config/providers.ts";
import { get, getKv, run, setKv } from "./db.ts";
import { sha1 } from "./lib/text.ts";

// ── 配置 ─────────────────────────────────────────────────────────────────────

export interface LlmConfig {
  preset: PresetKey;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** $/百万 token；null 表示不知道 */
  priceIn: number | null;
  priceOut: number | null;
  priceCached: number | null;
  extraBody: Record<string, unknown>;
}

export interface SavingConfig {
  /** 没人看的时候暂停模型 */
  onDemand: boolean;
  /** 多久没人看算"没人看"（分钟） */
  idleMinutes: number;
  /** 有人回来时，只用模型处理最近这么多小时的新闻，更早的用规则 */
  catchUpHours: number;
  /** 每日花费上限（美元），0 = 不限 */
  dailyCapUsd: number;
  /** 同一件事的其他报道直接沿用已有判断，不再调模型 */
  inherit: boolean;
  /** 门槛附近的条目再独立打一次分 */
  rescore: boolean;
}

export const DEFAULT_SAVING: SavingConfig = { onDemand: true, idleMinutes: 15, catchUpHours: 6, dailyCapUsd: 0.3, inherit: true, rescore: true };

function envConfig(): LlmConfig | null {
  const want = (process.env.LLM_PROVIDER || "auto").toLowerCase();
  const pick = (key: PresetKey, apiKey: string, model: string | undefined): LlmConfig => {
    const p = presetOf(key);
    return { preset: key, baseUrl: process.env.DEEPSEEK_BASE_URL || p.baseUrl, apiKey, model: model || p.model,
      priceIn: p.price?.[0] ?? null, priceOut: p.price?.[1] ?? null, priceCached: p.price?.[2] ?? null, extraBody: p.extraBody };
  };
  if (want === "off" || process.env.LLM_MODE === "off") return null;
  const ds = process.env.DEEPSEEK_API_KEY;
  const an = process.env.ANTHROPIC_API_KEY;
  if (ds && want !== "anthropic") return pick("deepseek", ds, process.env.DEEPSEEK_MODEL);
  if (an) return pick("anthropic", an, process.env.CLAUDE_MODEL);
  return null;
}

let disabledReason: string | null = null;
let lastViewerAt = 0;

/** 当前生效的配置和它的来源。 */
export function currentConfig(): { config: LlmConfig | null; source: "settings" | "env" | "none" } {
  const saved = getKv<LlmConfig>("llm_config")?.value;
  if (saved) return { config: saved.preset === "off" ? null : saved, source: "settings" };
  const env = envConfig();
  return { config: env, source: env ? "env" : "none" };
}

export function savingConfig(): SavingConfig {
  return { ...DEFAULT_SAVING, ...(getKv<Partial<SavingConfig>>("saving_config")?.value ?? {}) };
}

export function saveConfig(config: LlmConfig, saving: SavingConfig) {
  setKv("llm_config", config);
  setKv("saving_config", saving);
  disabledReason = null; // 换了配置，之前"Key 无效"之类的判断作废
}

/** 看板每次刷新都会调用：记下"有人在看"。返回之前是不是已经闲置了（闲置后第一次回来，调度会马上跑一轮）。 */
export function markViewer(): boolean {
  const wasIdle = Date.now() - lastViewerAt > savingConfig().idleMinutes * 60_000;
  lastViewerAt = Date.now();
  return wasIdle;
}

export function costToday(): { usd: number; calls: number } {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const r = get<{ usd: number | null; calls: number }>("SELECT sum(cost_usd) AS usd, count(*) AS calls FROM receipts WHERE status = 'ok' AND created_at >= ?", midnight.getTime());
  return { usd: r?.usd ?? 0, calls: r?.calls ?? 0 };
}

/**
 * 现在该怎么判断：
 *   llm   = 调模型
 *   rules = 用规则（没配模型、Key 失效、今天花到上限）
 *   wait  = 先排队（按需模式下没人在看）
 */
export function llmMode(): { mode: "llm" | "rules" | "wait"; reason: string | null } {
  const { config } = currentConfig();
  if (!config) return { mode: "rules", reason: "未配置模型" };
  if (disabledReason) return { mode: "rules", reason: disabledReason };
  const s = savingConfig();
  if (s.dailyCapUsd > 0 && costToday().usd >= s.dailyCapUsd) return { mode: "rules", reason: `今日花费已达上限 $${s.dailyCapUsd}` };
  if (s.onDemand && Date.now() - lastViewerAt > s.idleMinutes * 60_000) return { mode: "wait", reason: "没人在看，模型暂停" };
  return { mode: "llm", reason: null };
}

export function llmStatus() {
  const { config, source } = currentConfig();
  const m = llmMode();
  return {
    enabled: !!config && !disabledReason,
    provider: config ? presetOf(config.preset).name : null,
    model: config?.model ?? null,
    source,
    mode: m.mode,
    reason: m.reason,
    saving: savingConfig(),
    budget: BUDGET,
  };
}

// ── 预算（按调用次数的熔断，防止程序出错时狂调）────────────────────────────────

const BUDGET = {
  perMinute: Number(process.env.BUDGET_PER_MINUTE || 20),
  perHour: Number(process.env.BUDGET_PER_HOUR || 300),
  perDay: Number(process.env.BUDGET_PER_DAY || 2000),
};

export class BudgetExceededError extends Error {
  readonly retryAfterMs: number;
  constructor(window: string, retryAfterMs: number) {
    super(`预算熔断：${window} 调用数已满`);
    this.retryAfterMs = retryAfterMs;
  }
}
/** 暂时性问题（限流、服务端错误、网络、同一请求正在进行）：稍后重试。 */
export class RetryableError extends Error {}
/** 凭证缺失、无效或余额不足：改用规则模式，直到换配置。 */
export class LlmUnavailableError extends Error {}

function checkBudget(now: number) {
  const count = (ms: number) => get<{ n: number }>("SELECT count(*) AS n FROM receipts WHERE created_at > ?", now - ms)!.n;
  if (count(60_000) >= BUDGET.perMinute) throw new BudgetExceededError("每分钟", 60_000);
  if (count(3600_000) >= BUDGET.perHour) throw new BudgetExceededError("每小时", 10 * 60_000);
  if (count(86400_000) >= BUDGET.perDay) throw new BudgetExceededError("每天", 60 * 60_000);
}

interface Usage { input: number; cachedInput: number; output: number }

function estimateCost(c: LlmConfig, u: Usage): number | null {
  if (c.priceIn == null || c.priceOut == null) return null;
  return (u.input * c.priceIn + u.cachedInput * (c.priceCached ?? c.priceIn) + u.output * c.priceOut) / 1_000_000;
}

// ── 请求 ─────────────────────────────────────────────────────────────────────

export interface JsonCall<T> {
  /** 用途（judge / rescore / attribute），也进回执的 key。 */
  purpose: string;
  system: string;
  user: string;
  /** 输出的 JSON Schema。Claude 用结构化输出强制遵守；OpenAI 兼容接口只有 JSON 模式，schema 写进提示词，靠本地校验兜底。 */
  schema: Record<string, unknown>;
  /** 本地再校验一遍（zod）。 */
  validate: z.ZodType<T>;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
}

interface ChatResp {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
  error?: { message?: string };
}

async function callOpenAICompat(c: LlmConfig, system: string, user: string, schema: Record<string, unknown> | null, maxTokens: number): Promise<{ text: string; usage: Usage }> {
  const send = async (jsonMode: boolean) => {
    try {
      return await fetch(`${c.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${c.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: c.model,
          max_tokens: maxTokens,
          ...c.extraBody,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
          messages: [
            // system 放最前面且不变：多数服务商会自动缓存这段前缀，命中缓存的输入便宜很多。
            { role: "system", content: schema ? `${system}\n\n只输出一个 JSON 对象，不要任何其他文字。结构必须符合这个 JSON Schema：\n${JSON.stringify(schema)}` : system },
            { role: "user", content: user },
          ],
        }),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      throw new RetryableError(`network: ${String(error)}`);
    }
  };
  let res = await send(true);
  let body = (await res.json().catch(() => ({}))) as ChatResp;
  // 有的服务不支持 JSON 模式：去掉再试一次，靠提示词和本地校验。
  if (res.status === 400 && /response_format|json_object/i.test(body.error?.message ?? "")) {
    res = await send(false);
    body = (await res.json().catch(() => ({}))) as ChatResp;
  }
  const message = body.error?.message ?? `HTTP ${res.status}`;
  if (res.status === 401 || res.status === 403) throw new LlmUnavailableError(`API Key 无效或没有权限（${message.slice(0, 80)}）`);
  if (res.status === 402) throw new LlmUnavailableError("账户余额不足");
  if (res.status === 404) throw new LlmUnavailableError(`地址或模型不存在（${message.slice(0, 80)}）`);
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`${res.status}: ${message}`);
  if (!res.ok) throw new Error(`${res.status}: ${message}`);
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") throw new Error("输出被 max_tokens 截断");
  if (choice?.finish_reason === "content_filter") throw new Error("内容被过滤");
  const u = body.usage ?? {};
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    text: (choice?.message?.content ?? "").replace(/^```(?:json)?\s*|\s*```$/g, ""),
    usage: { input: u.prompt_cache_miss_tokens ?? Math.max(0, (u.prompt_tokens ?? 0) - cached), cachedInput: cached, output: u.completion_tokens ?? 0 },
  };
}

async function callAnthropic(c: LlmConfig, call: Pick<JsonCall<unknown>, "system" | "user" | "schema" | "effort">, maxTokens: number): Promise<{ text: string; usage: Usage }> {
  const client = new Anthropic({ apiKey: c.apiKey, maxRetries: 1, timeout: 120_000 });
  // Haiku 4.5 不接受 effort；服务端 refusal fallback 只在新一代 Opus / Sonnet 5.5 / Fable 上开。
  const supportsEffort = !c.model.startsWith("claude-haiku");
  const supportsFallback = /^claude-(opus-5|sonnet-5-5|fable)/.test(c.model);
  let res: Anthropic.Beta.BetaMessage;
  try {
    const params: Anthropic.Beta.MessageCreateParamsNonStreaming = {
      model: c.model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: call.system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: call.user }],
      output_config: {
        format: { type: "json_schema", schema: call.schema },
        ...(supportsEffort ? { effort: call.effort ?? "low" } : {}),
      },
      // 安全分类器误拒时，服务端自动换一个合适的模型重跑，不用自己维护模型列表。
      ...(supportsFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    };
    res = await client.beta.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) throw new LlmUnavailableError("API Key 无效或没有权限");
    if (error instanceof Anthropic.NotFoundError) throw new LlmUnavailableError(`模型不存在：${c.model}`);
    if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) throw new RetryableError(String(error));
    throw error;
  }
  // 先看 stop_reason，再读内容。
  if (res.stop_reason === "refusal") throw new Error(`模型拒绝了这次请求：${res.stop_details?.category ?? ""}`);
  if (res.stop_reason === "max_tokens") throw new Error("输出被 max_tokens 截断");
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")?.text ?? "";
  const u = res.usage;
  return { text, usage: { input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25, cachedInput: u.cache_read_input_tokens ?? 0, output: u.output_tokens } };
}

export async function callJson<T>(call: JsonCall<T>): Promise<T> {
  const { config: c } = currentConfig();
  if (!c || disabledReason) throw new LlmUnavailableError(disabledReason ?? "未配置模型");
  const now = Date.now();
  const key = sha1([c.preset, c.baseUrl, c.model, call.purpose, call.system, call.user].join("\u0001"));

  // 1. 回执：同样的请求已经付过钱，直接用存下来的结果。
  const prior = get<{ id: number; status: string; response: string | null; created_at: number }>("SELECT id, status, response, created_at FROM receipts WHERE key = ?", key);
  if (prior?.status === "ok" && prior.response) return call.validate.parse(JSON.parse(prior.response));
  if (prior?.status === "pending" && now - prior.created_at < 5 * 60_000) throw new RetryableError("同一请求正在进行");

  // 2. 预算熔断：先检查，再记账，再发请求。
  checkBudget(now);
  let receiptId: number;
  if (prior) {
    run("UPDATE receipts SET status = 'pending', created_at = ?, error = NULL WHERE id = ?", now, prior.id);
    receiptId = prior.id;
  } else {
    receiptId = Number(run("INSERT INTO receipts (key, service, purpose, model, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)", key, c.preset, call.purpose, c.model, now).lastInsertRowid);
  }
  const fail = (message: string) => run("UPDATE receipts SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", message.slice(0, 500), Date.now(), receiptId);

  // 3. 请求。
  let out: { text: string; usage: Usage };
  try {
    out = presetOf(c.preset).kind === "anthropic"
      ? await callAnthropic(c, call, call.maxTokens ?? 16000)
      : await callOpenAICompat(c, call.system, call.user, call.schema, call.maxTokens ?? 8000);
  } catch (error) {
    fail(String(error));
    if (error instanceof LlmUnavailableError) disabledReason = error.message;
    throw error;
  }

  // 4. 本地校验。格式不对按失败处理（会重试，反复失败就退回规则模式）。
  let parsed: T;
  try {
    parsed = call.validate.parse(JSON.parse(out.text));
  } catch (error) {
    fail(`bad output: ${String(error)}`);
    throw new Error(`模型输出不合法：${String(error).slice(0, 200)}`);
  }
  run("UPDATE receipts SET status = 'ok', response = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, finished_at = ? WHERE id = ?",
    out.text, Math.round(out.usage.input + out.usage.cachedInput), out.usage.output, estimateCost(c, out.usage), Date.now(), receiptId);
  return parsed;
}

// ── 设置页用：测试连接、获取模型列表（都不经过回执，只花几个 token）─────────────────

export async function testConnection(c: LlmConfig): Promise<{ ok: boolean; ms: number; message: string }> {
  const t = Date.now();
  try {
    const system = "你是连通性测试。";
    const user = "只回复 JSON：{\"ok\": true}";
    const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
    const out = presetOf(c.preset).kind === "anthropic"
      ? await callAnthropic(c, { system, user, schema, effort: "low" }, 200)
      : await callOpenAICompat(c, system, user, schema, 50);
    const ok = (JSON.parse(out.text) as { ok?: boolean }).ok === true;
    return { ok, ms: Date.now() - t, message: ok ? "连接成功" : `连上了，但返回的内容不对：${out.text.slice(0, 80)}` };
  } catch (error) {
    return { ok: false, ms: Date.now() - t, message: String(error instanceof Error ? error.message : error).slice(0, 300) };
  }
}

export async function listModels(c: LlmConfig): Promise<string[]> {
  if (presetOf(c.preset).kind === "anthropic") {
    const client = new Anthropic({ apiKey: c.apiKey, maxRetries: 0, timeout: 20_000 });
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  const res = await fetch(`${c.baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${c.apiKey}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id).sort();
}

export { PRESETS };
