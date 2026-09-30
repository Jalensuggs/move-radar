// 自选股：搜索、加入、移除。
// 搜索走 Nasdaq 的代码搜索（美股和 ETF）。加入时代码和名称一律由服务器自己去查，不信页面传来的，
// 然后拉两年行情、检测异动；之后它就和内置标的一样，被每轮行情刷新、异动检测和归因带上。
import type { AssetSpec } from "../config/assets.ts";
import { get, run } from "./db.ts";
import { fetchText } from "./lib/http.ts";
import { findAsset, isBuiltin, watchRows } from "./assets.ts";
import { refreshOneAsset } from "./collect/market.ts";
import { detectMoves } from "./moves.ts";

export const MAX_WATCH = 30;
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9./-]{0,9}$/;

/** 用户输入的可以预期的错误，页面直接显示给他看（HTTP 400），区别于程序出错。 */
export class WatchError extends Error {}

// Nasdaq 的搜索只认英文名和代码。常见公司给一份中文对照，输"特斯拉"也能搜到。
const CN_ALIASES: Record<string, string[]> = {
  苹果: ["AAPL"], 特斯拉: ["TSLA"], 微软: ["MSFT"], 谷歌: ["GOOGL"], 字母表: ["GOOGL"], 亚马逊: ["AMZN"], 脸书: ["META"], 英伟达: ["NVDA"],
  台积电: ["TSM"], 博通: ["AVGO"], 美光: ["MU"], 英特尔: ["INTC"], 高通: ["QCOM"], 阿斯麦: ["ASML"], 应用材料: ["AMAT"], 泛林: ["LRCX"],
  超微: ["AMD"], 奈飞: ["NFLX"], 网飞: ["NFLX"], 甲骨文: ["ORCL"], 思科: ["CSCO"], 德州仪器: ["TXN"], 迪士尼: ["DIS"], 波音: ["BA"],
  可口可乐: ["KO"], 麦当劳: ["MCD"], 耐克: ["NKE"], 星巴克: ["SBUX"], 沃尔玛: ["WMT"], 好市多: ["COST"], 摩根大通: ["JPM"], 高盛: ["GS"],
  伯克希尔: ["BRK.B"], 埃克森美孚: ["XOM"], 雪佛龙: ["CVX"], 辉瑞: ["PFE"], 礼来: ["LLY"], 联合健康: ["UNH"], 阿里巴巴: ["BABA"], 阿里: ["BABA"],
  拼多多: ["PDD"], 京东: ["JD"], 百度: ["BIDU"], 蔚来: ["NIO"], 小鹏: ["XPEV"], 理想: ["LI"], 哔哩哔哩: ["BILI"], 网易: ["NTES"],
  帕兰提尔: ["PLTR"], 奥多比: ["ADBE"], 优步: ["UBER"], 爱彼迎: ["ABNB"], 支付宝: ["BABA"], 索尼: ["SONY"], 丰田: ["TM"],
  标普ETF: ["SPY"], 纳指ETF: ["QQQ"], 黄金ETF: ["GLD"], 原油ETF: ["USO"],
};

export interface SearchHit {
  symbol: string;
  name: string;
  short: string;
  type: "stock" | "etf";
  exchange: string;
  /** default = 已经在内置列表里；watch = 已经在自选里；none = 还没加 */
  state: "default" | "watch" | "none";
}

interface NasdaqRow { symbol: string; name: string; exchange: string; asset: string }

const cache = new Map<string, { at: number; rows: NasdaqRow[] }>();
const CACHE_MS = 10 * 60_000;

async function nasdaqLookup(q: string): Promise<NasdaqRow[]> {
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const r = await fetchText(`https://api.nasdaq.com/api/autocomplete/slookup/10?search=${encodeURIComponent(q)}`, { headers: { accept: "application/json" }, timeoutMs: 8000 });
  const body = JSON.parse(r.text) as { data?: NasdaqRow[] | null };
  // 只要股票和 ETF：基金、票据这些行情接口查不到。
  const rows = (body.data ?? []).filter((x) => x.asset === "STOCKS" || x.asset === "ETF");
  if (cache.size >= 300) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** "Apple Inc. Common Stock" → "Apple"；"Alphabet Inc. Class A Common Stock" → "Alphabet"。用来显示和搜新闻。 */
export function shortName(name: string): string {
  let s = name.trim().replace(/\s*\((The)\)/i, "");
  s = s.replace(/\s+(Class\s+[A-Z]\b.*|Common Stock|Common Shares|Ordinary Shares?|American Depositary (Shares|Receipts?).*|Depositary Shares.*|Units?|Warrants?.*|Series [A-Z].*)$/i, "");
  s = s.replace(/,?\s+Series\s+\d+$/i, "");
  for (let i = 0; i < 3; i++) s = s.replace(/[,\s]+(Inc|Corp|Corporation|Company|Co|Ltd|Limited|PLC|N\.V|S\.A|Holdings?|Group|Incorporated|Trust|New)\.?$/i, "");
  s = s.replace(/\s*&\s*$/, ""); // "JP Morgan Chase & Co." 去掉 Co. 后剩个尾巴 &
  return s.trim() || name.trim();
}

const stateOf = (symbol: string): SearchHit["state"] => (isBuiltin(symbol) ? "default" : findAsset(symbol) ? "watch" : "none");

function toHit(r: NasdaqRow): SearchHit {
  return { symbol: r.symbol, name: r.name, short: shortName(r.name), type: r.asset === "ETF" ? "etf" : "stock", exchange: r.exchange || "", state: stateOf(r.symbol) };
}

/**
 * Nasdaq 返回的顺序不太对（搜 "intel" 时英特尔排第 6，前面是名字里碰巧带 intel 的小公司）。
 * 重排：代码完全一样 → 公司简称完全一样 → 代码开头一样 → 简称以搜索词开头 → 包含 → 其余；同一档里主板上市的（NASDAQ / NYSE）在前。
 */
function rank(rows: NasdaqRow[], q: string): NasdaqRow[] {
  const lq = q.toLowerCase();
  const tier = (r: NasdaqRow) => {
    const sym = r.symbol.toLowerCase();
    const name = shortName(r.name).toLowerCase();
    return sym === lq ? 0 : name === lq ? 1 : sym.startsWith(lq) ? 2 : name.startsWith(`${lq} `) ? 3 : name.startsWith(lq) ? 4 : name.includes(lq) ? 5 : 6;
  };
  const main = (r: NasdaqRow) => (/^(NASDAQ|NYSE)(?!.*ARCA)/i.test(r.exchange) ? 0 : 1);
  return [...rows].sort((a, b) => tier(a) - tier(b) || main(a) - main(b));
}

export async function searchSymbols(raw: string): Promise<{ results: SearchHit[]; hint?: string }> {
  const q = raw.trim().slice(0, 30);
  if (!q) return { results: [] };
  if (/[^\x00-\x7f]/.test(q)) {
    // 中文：查对照表，每个代码再去 Nasdaq 确认一下（拿到官方名称和交易所）。
    const tickers = [...new Set(Object.entries(CN_ALIASES).filter(([k]) => k.includes(q) || q.includes(k)).flatMap(([, v]) => v))].slice(0, 4);
    if (!tickers.length) return { results: [], hint: "中文只认常见公司名（如 特斯拉、台积电）。其他的请输入代码或英文名。" };
    const found: SearchHit[] = [];
    for (const t of tickers) {
      const row = (await nasdaqLookup(t)).find((x) => x.symbol.toUpperCase() === t);
      if (row) found.push(toHit(row));
    }
    return { results: found };
  }
  const clean = q.replace(/[^A-Za-z0-9 .&'\-]/g, "").trim();
  if (!clean) return { results: [] };
  return { results: rank(await nasdaqLookup(clean), clean).slice(0, 8).map(toHit) };
}

export async function addToWatchlist(raw: string): Promise<AssetSpec> {
  const symbol = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(symbol)) throw new WatchError("代码格式不对");
  if (isBuiltin(symbol)) throw new WatchError(`${symbol} 已经在默认列表里了`);
  const existing = findAsset(symbol);
  if (existing) return existing;
  if (watchRows().length >= MAX_WATCH) throw new WatchError(`自选最多 ${MAX_WATCH} 个，先移除几个再加`);

  // 名称、分类由服务器自己查，不信页面传来的。
  let row: NasdaqRow | undefined;
  try {
    row = (await nasdaqLookup(symbol)).find((x) => x.symbol.toUpperCase() === symbol);
  } catch (error) {
    throw new WatchError(`暂时查不了这个代码，稍后再试（${String(error instanceof Error ? error.message : error).slice(0, 60)}）`);
  }
  if (!row) throw new WatchError("没找到这个代码。目前只支持美股和 ETF。");

  run("INSERT INTO watchlist (symbol, name, short_name, cls, exchange, added_at) VALUES (?, ?, ?, ?, ?, ?)",
    symbol, row.name, shortName(row.name), row.asset === "ETF" ? "etf" : "stocks", row.exchange || null, Date.now());
  const spec = findAsset(symbol)!;
  try {
    const points = await refreshOneAsset(spec);
    if (points < 5) throw new WatchError("没有拿到这个标的的行情（可能刚上市，或者数据源不支持）");
  } catch (error) {
    removeFromWatchlist(symbol); // 拉不到行情的不留在列表里
    throw error instanceof WatchError ? error : new WatchError(`拉行情失败：${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
  }
  detectMoves([spec]);
  return spec;
}

export function removeFromWatchlist(symbol: string): boolean {
  const s = symbol.trim().toUpperCase();
  if (isBuiltin(s)) throw new WatchError("默认列表里的不能移除");
  const found = !!get("SELECT 1 FROM watchlist WHERE symbol = ?", s);
  run("DELETE FROM watchlist WHERE symbol = ?", s);
  run("DELETE FROM prices WHERE symbol = ?", s);
  run("DELETE FROM moves WHERE symbol = ?", s);
  return found;
}
