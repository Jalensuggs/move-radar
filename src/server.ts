// HTTP：看板页面 + JSON 接口。页面只读库里已经算好的结果，打开页面不会触发抓取或模型调用
// （唯一例外是 POST /api/attribute：读者点了一个还没归因的历史异动）。
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUP_NAMES, LEVELS } from "../config/assets.ts";
import { allAssets, findAsset } from "./assets.ts";
import { addToWatchlist, removeFromWatchlist, searchSymbols, WatchError } from "./watchlist.ts";
import { TOPICS } from "../config/topics.ts";
import { all, get, getKv } from "./db.ts";
import { hotEvents } from "./events.ts";
import { series } from "./collect/market.ts";
import { PRESETS, presetOf } from "../config/providers.ts";
import { costToday, currentConfig, DEFAULT_SAVING, listModels, llmStatus, markViewer, saveConfig, savingConfig, testConnection, type LlmConfig, type SavingConfig } from "./llm.ts";
import { attributeMove, MOVE_Z, type Attribution, type MoveRow } from "./moves.ts";
import { SELECT_THRESHOLD } from "./judge.ts";
import { tick } from "./worker.ts";
import { authProblem, isAdmin, login, sameOrigin, takePublicAttribution, takeSearch } from "./auth.ts";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

/** 所有响应都带：不让浏览器猜类型、不许被别的网站用 iframe 套住（防点击劫持）、不外泄来源页。 */
const SECURITY = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY });
  res.end(JSON.stringify(body));
}

/** 需要管理员的接口：不是就直接回 401 / 403，返回 false。 */
function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAdmin(req)) return true;
  const { status, error } = authProblem();
  send(res, status, { error });
  return false;
}

function tile(symbol: string, name: string, extra: Record<string, unknown> = {}) {
  const pts = series(symbol, 60);
  const last = pts.at(-1);
  const prev = pts.at(-2);
  return {
    symbol, name, ...extra,
    close: last?.close ?? null,
    date: last?.date ?? null,
    change: last && prev ? last.close / prev.close - 1 : null,
    spark: pts.slice(-30).map((p) => p.close),
  };
}

/** admin：这个访客是不是管理员（页面据此显示"移除自选"）。导出静态快照时不传，就是 false。 */
export function overview(admin = false) {
  const dayAgo = Date.now() - 86400_000;
  const counts = get<{ total: number; judged: number; relevant: number; selected: number }>(
    `SELECT count(*) AS total, sum(state = 'judged') AS judged, sum(relevant = 1) AS relevant, sum(selected = 1) AS selected
     FROM articles WHERE discovered_at > ? AND backfill = 0`, dayAgo)!;
  const sources = get<{ total: number; ok: number }>("SELECT count(*) AS total, sum(health = 'ok') AS ok FROM sources WHERE enabled = 1")!;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  // 今天每条新闻是怎么判的：调了模型 / 沿用 / 规则。看得出省钱策略省了多少。
  const usage = Object.fromEntries(all<{ mode: string; n: number }>(
    "SELECT coalesce(mode, 'rules') AS mode, count(*) AS n FROM articles WHERE judged_at >= ? GROUP BY 1", midnight.getTime()).map((r) => [r.mode, r.n]));
  return {
    generatedAt: Date.now(),
    admin,
    llm: llmStatus(),
    cost: costToday(),
    usage: { llm: usage.llm ?? 0, inherit: usage.inherit ?? 0, rules: usage.rules ?? 0 },
    thresholds: { select: SELECT_THRESHOLD, moveZ: MOVE_Z },
    groups: GROUP_NAMES,
    topics: TOPICS.map((t) => ({ key: t.key, name: t.name })),
    tiles: [
      ...allAssets().map((a) => tile(a.symbol, a.name, { group: a.group, note: a.note ?? null, custom: !!a.custom })),
      // 现货价来自 FRED，有的服务器连不上它：没数据的卡片直接不显示。
      ...LEVELS.map((l) => tile(l.symbol, l.name, { group: "level" })).filter((t) => t.close != null),
    ],
    fearGreed: {
      cnn: getKv("cnn_fear_greed")?.value ?? null,
      history: all<{ date: string; score: number }>("SELECT date, score FROM (SELECT date, score FROM fear_greed ORDER BY date DESC LIMIT 250) ORDER BY date"),
    },
    stats: {
      articles24h: counts.total ?? 0, judged24h: counts.judged ?? 0, relevant24h: counts.relevant ?? 0, selected24h: counts.selected ?? 0,
      sourcesOk: sources.ok ?? 0, sourcesTotal: sources.total ?? 0,
      pending: get<{ n: number }>("SELECT count(*) AS n FROM articles WHERE state = 'new'")!.n,
      marketAt: getKv<number>("market_refreshed_at")?.value ?? null,
      lastCollectAt: get<{ t: number | null }>("SELECT max(finished_at) AS t FROM runs WHERE job = 'news.collect' AND status = 'ok'")?.t ?? null,
    },
  };
}

// ── AI 设置 ─────────────────────────────────────────────────────────────────

const keyHint = (k: string) => (k ? `${k.slice(0, 3)}…${k.slice(-4)}` : "");

function settingsView() {
  const { config, source } = currentConfig();
  const saved = getKv<LlmConfig>("llm_config")?.value;
  const shown = config ?? saved ?? null;
  return {
    presets: PRESETS,
    source,
    // Key 永远不回传给页面，只给一个提示（前 3 位 + 后 4 位）。
    current: shown
      ? { preset: shown.preset, baseUrl: shown.baseUrl, model: shown.model, priceIn: shown.priceIn, priceOut: shown.priceOut, priceCached: shown.priceCached, extraBody: shown.extraBody, keySet: !!shown.apiKey, keyHint: keyHint(shown.apiKey) }
      : { preset: "off", baseUrl: "", model: "", priceIn: null, priceOut: null, priceCached: null, extraBody: {}, keySet: false, keyHint: "" },
    saving: savingConfig(),
    status: llmStatus(),
  };
}

const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const price = (v: unknown) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);

/** 页面提交的表单 → 完整配置。Key 留空表示沿用已保存的（页面拿不到原 Key，也就没法回传）。 */
function parseConfig(body: Record<string, unknown>): LlmConfig {
  const preset = presetOf(String(body.preset ?? "off"));
  const existing = currentConfig().config ?? getKv<LlmConfig>("llm_config")?.value ?? null;
  const typed = String(body.apiKey ?? "").trim();
  const apiKey = typed || (existing?.preset === preset.key ? existing.apiKey : "");
  const baseUrl = String(body.baseUrl ?? preset.baseUrl).trim() || preset.baseUrl;
  let extraBody: Record<string, unknown> = preset.extraBody;
  if (body.extraBody && typeof body.extraBody === "object" && !Array.isArray(body.extraBody)) extraBody = body.extraBody as Record<string, unknown>;
  const cfg: LlmConfig = {
    preset: preset.key, baseUrl, apiKey, model: String(body.model ?? "").trim(),
    priceIn: price(body.priceIn), priceOut: price(body.priceOut), priceCached: price(body.priceCached), extraBody,
  };
  if (preset.kind === "off") return cfg;
  if (preset.kind === "openai" && !/^https?:\/\/[^\s]+$/.test(cfg.baseUrl)) throw new Error("API 地址不对，要以 http:// 或 https:// 开头");
  if (!cfg.model) throw new Error("请填模型名称（可以点「获取模型列表」）");
  // 本地模型（Ollama 等）可以不要 Key，其余都要。
  if (!cfg.apiKey && preset.key !== "custom") throw new Error("请填 API Key");
  return cfg;
}

function parseSaving(v: unknown): SavingConfig {
  const s = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return {
    onDemand: s.onDemand === undefined ? DEFAULT_SAVING.onDemand : !!s.onDemand,
    idleMinutes: num(s.idleMinutes, 5, 240, DEFAULT_SAVING.idleMinutes),
    catchUpHours: num(s.catchUpHours, 1, 48, DEFAULT_SAVING.catchUpHours),
    dailyCapUsd: num(s.dailyCapUsd, 0, 100, DEFAULT_SAVING.dailyCapUsd),
    inherit: s.inherit === undefined ? DEFAULT_SAVING.inherit : !!s.inherit,
    rescore: s.rescore === undefined ? DEFAULT_SAVING.rescore : !!s.rescore,
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 64_000) throw new Error("请求太大");
  }
  return JSON.parse(body || "{}") as Record<string, unknown>;
}

export function moveSummary(m: MoveRow) {
  const at = m.attribution ? (JSON.parse(m.attribution) as Attribution) : null;
  return {
    symbol: m.symbol, name: findAsset(m.symbol)?.name ?? m.symbol, date: m.date, ret: m.ret, z: m.z, close: m.close, forced: !!m.forced,
    attributed: !!at, mode: at?.mode ?? null, confidence: at?.confidence ?? null,
    primary: at?.primary ? { title: at.primary.title, publisher: at.primary.publisher, url: at.primary.url } : null,
    explanation: at?.explanation ?? null,
  };
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k);

  // 健康检查：不算"有人在看"（否则"没人看就暂停模型"永远不生效），也不碰数据库以外的东西。
  if (p === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "POST" && !sameOrigin(req)) return send(res, 403, { error: "forbidden" });

  if (p === "/api/login" && req.method === "POST") {
    const body = await readJson(req);
    const r = login(req, res, String(body.password ?? ""));
    return send(res, r.status, r.ok ? { ok: true } : { error: r.error });
  }

  if (p === "/api/overview") {
    // 看板每分钟（页面可见时）刷新一次，这就是"有人在看"的信号。闲置后第一次回来，马上跑一轮把积压的新闻处理掉。
    if (markViewer() && process.env.WORKER !== "off") void tick();
    return send(res, 200, overview(isAdmin(req)));
  }
  if (p.startsWith("/api/settings") && !requireAdmin(req, res)) return;
  if (p === "/api/settings" && req.method === "GET") return send(res, 200, settingsView());
  if (p === "/api/settings" && req.method === "POST") {
    const body = await readJson(req);
    try {
      saveConfig(parseConfig(body), parseSaving(body.saving));
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return send(res, 200, settingsView());
  }
  if (p === "/api/settings/test" && req.method === "POST") {
    try {
      const cfg = parseConfig(await readJson(req));
      if (presetOf(cfg.preset).kind === "off") return send(res, 200, { ok: true, ms: 0, message: "规则模式不需要连接" });
      return send(res, 200, await testConnection(cfg));
    } catch (error) {
      return send(res, 200, { ok: false, ms: 0, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (p === "/api/settings/models" && req.method === "POST") {
    try {
      const body = await readJson(req);
      const cfg = parseConfig({ ...body, model: body.model || "_" }); // 列模型时还没选模型
      return send(res, 200, { models: await listModels(cfg) });
    } catch (error) {
      return send(res, 200, { models: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  // 股票搜索（公开，限流）和自选（加入 / 移除只有管理员）
  if (p === "/api/search") {
    if (!takeSearch(req)) return send(res, 429, { error: "搜得太快了，过一会儿再试" });
    try {
      return send(res, 200, await searchSymbols(q("q") ?? ""));
    } catch (error) {
      return send(res, 200, { results: [], hint: `暂时搜不了：${String(error instanceof Error ? error.message : error).slice(0, 60)}` });
    }
  }
  if (p === "/api/watchlist" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      const a = await addToWatchlist(String((await readJson(req)).symbol ?? ""));
      return send(res, 200, { ok: true, symbol: a.symbol, name: a.name });
    } catch (error) {
      if (error instanceof WatchError) return send(res, 400, { error: error.message });
      throw error;
    }
  }
  if (p === "/api/watchlist/remove" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    try {
      return send(res, 200, { ok: removeFromWatchlist(String((await readJson(req)).symbol ?? "")) });
    } catch (error) {
      if (error instanceof WatchError) return send(res, 400, { error: error.message });
      throw error;
    }
  }
  if (p === "/api/hot") return send(res, 200, { events: hotEvents({ topic: q("topic") || null, limit: Number(q("limit") || 20) }) });
  if (p === "/api/feed") {
    const topic = q("topic");
    const rows = all(`SELECT id, topic, title, title_zh, summary_zh, publisher, url, timeline_at AS at, importance, score2, mode, event_id
      FROM articles WHERE selected = 1 AND backfill = 0 ${topic ? "AND topic = ?" : ""} ORDER BY timeline_at DESC LIMIT ?`, ...(topic ? [topic] : []), Number(q("limit") || 40));
    return send(res, 200, { items: rows });
  }
  if (p === "/api/chart") {
    const a = findAsset(q("symbol") ?? "");
    if (!a) return send(res, 404, { error: "unknown symbol" });
    const moves = all<MoveRow>("SELECT * FROM moves WHERE symbol = ? ORDER BY date", a.symbol).map(moveSummary);
    return send(res, 200, { asset: { symbol: a.symbol, name: a.name, note: a.note ?? null, group: a.group }, series: series(a.symbol, 520), moves });
  }
  if (p === "/api/move") {
    const m = get<MoveRow>("SELECT * FROM moves WHERE symbol = ? AND date = ?", q("symbol") ?? "", q("date") ?? "");
    if (!m) return send(res, 404, { error: "no such move" });
    return send(res, 200, { move: moveSummary(m), attribution: m.attribution ? JSON.parse(m.attribution) : null });
  }
  if (p === "/api/moves") {
    const since = new Date(Date.now() - Number(q("days") || 30) * 86400_000).toISOString().slice(0, 10);
    return send(res, 200, { moves: all<MoveRow>("SELECT * FROM moves WHERE date >= ? AND forced = 0 ORDER BY date DESC, abs(z) DESC LIMIT 60", since).map(moveSummary) });
  }
  if (p === "/api/attribute" && req.method === "POST") {
    const { symbol, date } = (await readJson(req)) as { symbol?: string; date?: string };
    if (!symbol || !date || !findAsset(symbol) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: "symbol and date required" });
    // 已经归因过的直接给结果：不重算、不花钱、不占访客额度。
    const done = get<MoveRow>("SELECT * FROM moves WHERE symbol = ? AND date = ? AND attribution IS NOT NULL", symbol, date);
    if (done) return send(res, 200, { move: moveSummary(done), attribution: JSON.parse(done.attribution!) });
    // 现场归因要去外面抓新闻、调模型：访客限次，管理员不限。
    const allowance = takePublicAttribution(req);
    if (!allowance.ok) return send(res, 429, { error: allowance.error });
    const attribution = await attributeMove(symbol, date);
    const m = get<MoveRow>("SELECT * FROM moves WHERE symbol = ? AND date = ?", symbol, date);
    return send(res, attribution ? 200 : 404, { move: m ? moveSummary(m) : null, attribution });
  }
  if (p === "/api/status") {
    if (!requireAdmin(req, res)) return; // 里面有信源的报错信息
    return send(res, 200, {
      llm: llmStatus(),
      sources: all("SELECT id, name, kind, topic, health, interval_min, fail_count, last_ok_at, last_error, (SELECT count(*) FROM articles a WHERE a.source_id = sources.id) AS articles FROM sources WHERE enabled = 1 ORDER BY topic, id"),
      runs: all("SELECT job, status, started_at, finished_at, detail FROM runs WHERE id IN (SELECT max(id) FROM runs GROUP BY job) ORDER BY job"),
    });
  }

  // 图表库从 node_modules 直接给，不依赖 CDN，离线也能用。
  if (p === "/vendor/echarts.min.js") {
    const body = await readFile(path.join(WEB, "..", "node_modules", "echarts", "dist", "echarts.min.js"));
    res.writeHead(200, { "content-type": TYPES[".js"]!, "cache-control": "public, max-age=86400", ...SECURITY });
    return res.end(body);
  }

  // 静态文件
  const file = p === "/" ? "index.html" : p.slice(1);
  if (!/^[\w.-]+$/.test(file)) return send(res, 404, { error: "not found" });
  try {
    const body = await readFile(path.join(WEB, file));
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache", ...SECURITY });
    res.end(body);
  } catch {
    send(res, 404, { error: "not found" });
  }
}

export function startServer(port = Number(process.env.PORT || 3000)) {
  const server = createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error("[http]", error);
      if (!res.headersSent) send(res, 500, { error: String(error instanceof Error ? error.message : error) });
    });
  });
  // 本机开发只听回环地址；放进容器要设 HOST=0.0.0.0（由 compose 只映射到宿主机的 127.0.0.1，再由 Caddy 反代）。
  const host = process.env.HOST || "127.0.0.1";
  server.listen(port, host, () => console.log(`异动雷达 → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`));
  return server;
}
