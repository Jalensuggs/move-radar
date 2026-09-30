// 管理员登录、来源判断和限流。看板本身是公开只读的；改设置（会碰 API Key）、看运行状态需要管理员，
// 现场归因（会花模型的钱、会去外面抓新闻）对访客限次。
//
// 规则：
//   - 设了 ADMIN_PASSWORD：改设置要先登录（密码 → 7 天的 HttpOnly Cookie）。
//   - 没设：只有本机直接访问（回环地址、且没有反向代理转发的痕迹）才算管理员，也就是本地开发照旧；
//     部署到服务器后不设密码，远程就是改不了设置，宁可锁死也不裸奔。
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "radar_admin";
const SESSION_MS = 7 * 86400_000;
const sessions = new Map<string, number>();
const loginFails = new Map<string, number[]>();

const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 10 * 60_000;
/** 访客每小时最多触发多少次现场归因：全站合计，和每个 IP。 */
const ATTRIBUTE_GLOBAL_PER_HOUR = Number(process.env.PUBLIC_ATTRIBUTE_PER_HOUR || 6);
const ATTRIBUTE_IP_PER_HOUR = 2;
const attributions: Array<{ at: number; ip: string }> = [];

const password = () => (process.env.ADMIN_PASSWORD ?? "").trim();
/** 前面有自己的反向代理（Caddy / Nginx）时才信任 X-Forwarded-For，直接暴露时它可以被伪造。 */
const trustProxy = () => process.env.TRUST_PROXY === "true";

export function clientIp(req: IncomingMessage): string {
  if (trustProxy()) {
    const xff = req.headers["x-forwarded-for"];
    const first = String(Array.isArray(xff) ? xff[0] : xff ?? "").split(",")[0]!.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** 直接从本机访问：回环地址，并且没有经过反向代理（代理转发的请求在服务端看来也是本机）。 */
function isLocal(req: IncomingMessage): boolean {
  const ra = req.socket.remoteAddress ?? "";
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  return loopback && !req.headers["x-forwarded-for"] && !req.headers.forwarded;
}

function sessionToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=") || null;
  }
  return null;
}

export function isAdmin(req: IncomingMessage): boolean {
  if (!password()) return isLocal(req);
  const token = sessionToken(req);
  const exp = token ? sessions.get(token) : undefined;
  if (!token || !exp) return false;
  if (exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

/** 给页面的提示：没登录时该怎么办。 */
export function authProblem(): { status: 401 | 403; error: string } {
  return password()
    ? { status: 401, error: "需要管理员登录" }
    : { status: 403, error: "服务器没有设置 ADMIN_PASSWORD，远程访问不能修改设置。在服务器的 .env 里设置后重启。" };
}

const digest = (s: string) => createHash("sha256").update(s).digest();

export function login(req: IncomingMessage, res: ServerResponse, given: string): { ok: boolean; status: number; error?: string } {
  if (!password()) return { ok: false, status: 403, error: authProblem().error };
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (loginFails.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (recent.length >= LOGIN_MAX_FAILS) return { ok: false, status: 429, error: "试错次数太多，10 分钟后再试" };
  // 先各自哈希再比较：长度固定，比较耗时和内容无关。
  if (!timingSafeEqual(digest(given), digest(password()))) {
    loginFails.set(ip, [...recent, now]);
    return { ok: false, status: 401, error: "密码不对" };
  }
  loginFails.delete(ip);
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
  if (sessions.size >= 50) sessions.delete(sessions.keys().next().value!);
  const token = randomBytes(32).toString("hex");
  sessions.set(token, now + SESSION_MS);
  const https = (trustProxy() && req.headers["x-forwarded-proto"] === "https") || "encrypted" in req.socket;
  res.setHeader("set-cookie", `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${https ? "; Secure" : ""}`);
  return { ok: true, status: 200 };
}

/** 访客要触发一次现场归因：还有额度就记一笔并放行。管理员不限。 */
export function takePublicAttribution(req: IncomingMessage): { ok: boolean; error?: string } {
  if (isAdmin(req)) return { ok: true };
  const ip = clientIp(req);
  const since = Date.now() - 3600_000;
  while (attributions.length && attributions[0]!.at < since) attributions.shift();
  if (attributions.length >= ATTRIBUTE_GLOBAL_PER_HOUR) return { ok: false, error: "现场归因是要花钱的，这个小时的公共额度用完了，晚点再来。本地运行可以不限次。" };
  if (attributions.filter((a) => a.ip === ip).length >= ATTRIBUTE_IP_PER_HOUR) return { ok: false, error: "你这个小时的现场归因次数用完了，晚点再来。" };
  attributions.push({ at: Date.now(), ip });
  return { ok: true };
}

/**
 * 改状态的请求只接受本页面发来的：别的网站借你的浏览器往这里发请求（CSRF）会因为 Origin 不对被拒；
 * 要求 JSON 也会让跨站请求先被浏览器的预检拦下。只比较主机（含端口），不比较 http / https：
 * 放在 HTTPS 反向代理后面时，浏览器发的是 https://，服务端自己看到的是 http。
 */
export function sameOrigin(req: IncomingMessage): boolean {
  if (!/application\/json/.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}
