// 行情与情绪：Nasdaq 数据接口（个股、指数、ETF）、FRED（官方序列）、CNN 恐慌贪婪指数。
// 都不需要 key。第一次拉两年历史，之后每次只补最近几周。
import { ASSETS, LEVELS, type AssetSpec } from "../../config/assets.ts";
import { all, get, run, setKv, tx } from "../db.ts";
import { etDate, addDays } from "../lib/text.ts";
import { fetchJson, fetchText, sleep } from "../lib/http.ts";

const HISTORY_DAYS = 730;

interface NasdaqResp {
  data: { tradesTable: { rows: Array<{ date: string; close: string }> | null } | null } | null;
  status?: { bCodeMessage?: Array<{ errorMessage: string }> | null };
}

const num = (s: string) => Number(s.replace(/[$,]/g, ""));

async function nasdaqSeries(sym: string, cls: string, from: string): Promise<Array<[string, number]>> {
  const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/historical?assetclass=${cls}&fromdate=${from}&limit=1000`;
  const j = await fetchJson<NasdaqResp>(url);
  const rows = j.data?.tradesTable?.rows;
  if (!rows) throw new Error(`nasdaq ${sym}: ${j.status?.bCodeMessage?.[0]?.errorMessage ?? "no data"}`);
  return rows.map((r) => {
    const [m, d, y] = r.date.split("/");
    return [`${y}-${m}-${d}`, num(r.close)] as [string, number];
  }).filter(([, c]) => Number.isFinite(c) && c > 0);
}

async function fredSeries(id: string, from: string): Promise<Array<[string, number]>> {
  const r = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`);
  return r.text.trim().split("\n").slice(1)
    .map((line) => line.split(","))
    .filter(([, v]) => v && v !== "." && Number.isFinite(Number(v)))
    .map(([d, v]) => [d!, Number(v)] as [string, number]);
}

interface CnnPoint { x: number; y: number; rating?: string }
type CnnResp = Record<string, { score?: number; rating?: string; data?: CnnPoint[]; previous_close?: number; previous_1_week?: number; previous_1_month?: number; previous_1_year?: number }>;

/** CNN 的历史点是 UTC 零点（按 UTC 取日期），当天的点是盘中时间（按美东取日期）。 */
const cnnDate = (x: number) => (x % 86_400_000 === 0 ? new Date(x).toISOString().slice(0, 10) : etDate(x));

async function fetchCnn(): Promise<CnnResp> {
  return fetchJson<CnnResp>("https://production.dataviz.cnn.io/index/fearandgreed/graphdata", { referer: "https://edition.cnn.com/", origin: "https://edition.cnn.com" });
}

const COMPONENT_NAMES: Record<string, string> = {
  market_momentum_sp500: "市场动能（标普 vs 125 日均线）",
  stock_price_strength: "股价强度（52 周新高 vs 新低）",
  stock_price_breadth: "市场广度（上涨 vs 下跌成交量）",
  put_call_options: "看跌/看涨期权比",
  market_volatility_vix: "市场波动率（VIX）",
  junk_bond_demand: "垃圾债需求",
  safe_haven_demand: "避险需求（股票 vs 国债）",
};

function upsertPrices(symbol: string, points: Array<[string, number]>) {
  tx(() => {
    for (const [date, close] of points) {
      run("INSERT INTO prices (symbol, date, close) VALUES (?, ?, ?) ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close", symbol, date, close);
    }
  });
}

function fromDate(symbol: string): string {
  const last = get<{ d: string | null }>("SELECT max(date) AS d FROM prices WHERE symbol = ?", symbol)?.d;
  const today = etDate(Date.now());
  return last ? addDays(last, -14) : addDays(today, -HISTORY_DAYS);
}

async function refreshAsset(a: AssetSpec, cnn: CnnResp | null): Promise<number> {
  const from = fromDate(a.symbol);
  let points: Array<[string, number]>;
  if (a.feed.p === "nasdaq") {
    points = await nasdaqSeries(a.feed.sym, a.feed.cls, from);
  } else {
    points = await fredSeries(a.feed.id, from);
    // FRED 有发布延迟，用 CNN 数据里的同一序列补上最近几天（含盘中最新值）。
    const extra = a.feed.cnn ? cnn?.[a.feed.cnn]?.data ?? [] : [];
    const lastFred = points.at(-1)?.[0] ?? "";
    for (const p of extra) {
      const d = cnnDate(p.x);
      if (d > lastFred && d >= from) points.push([d, p.y]);
    }
  }
  upsertPrices(a.symbol, points);
  return points.length;
}

export async function refreshMarket(): Promise<Record<string, number | string>> {
  const out: Record<string, number | string> = {};
  let cnn: CnnResp | null = null;
  try {
    cnn = await fetchCnn();
    const hist = cnn.fear_and_greed_historical?.data ?? [];
    tx(() => {
      for (const p of hist) run("INSERT INTO fear_greed (date, score, rating) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET score = excluded.score, rating = excluded.rating", cnnDate(p.x), p.y, p.rating ?? null);
    });
    const fg = cnn.fear_and_greed;
    setKv("cnn_fear_greed", {
      score: fg?.score, rating: fg?.rating, previousClose: fg?.previous_close, previousWeek: fg?.previous_1_week,
      previousMonth: fg?.previous_1_month, previousYear: fg?.previous_1_year,
      components: Object.entries(COMPONENT_NAMES).map(([key, name]) => ({ key, name, score: cnn?.[key]?.score ?? null, rating: cnn?.[key]?.rating ?? null })),
    });
    out.cnn = hist.length;
  } catch (error) {
    out.cnn = `error: ${String(error)}`.slice(0, 200);
  }
  for (const a of ASSETS) {
    try {
      out[a.symbol] = await refreshAsset(a, cnn);
    } catch (error) {
      out[a.symbol] = `error: ${String(error)}`.slice(0, 200);
    }
    if (a.feed.p === "nasdaq") await sleep(350); // 客气一点，别连着打
  }
  for (const l of LEVELS) {
    try {
      const pts = await fredSeries(l.fredId, fromDate(l.symbol));
      upsertPrices(l.symbol, pts);
      out[l.symbol] = pts.length;
    } catch (error) {
      out[l.symbol] = `error: ${String(error)}`.slice(0, 200);
    }
  }
  setKv("market_refreshed_at", Date.now());
  return out;
}

export function series(symbol: string, days = 400): Array<{ date: string; close: number }> {
  return all<{ date: string; close: number }>(
    "SELECT date, close FROM (SELECT date, close FROM prices WHERE symbol = ? ORDER BY date DESC LIMIT ?) ORDER BY date", symbol, days);
}

/** 某个交易日各标的的涨跌幅（用于判断是不是大盘共振）。 */
export function dayReturns(date: string, symbols: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const s of symbols) {
    const rows = all<{ date: string; close: number }>("SELECT date, close FROM prices WHERE symbol = ? AND date <= ? ORDER BY date DESC LIMIT 2", s, date);
    out[s] = rows.length === 2 && rows[0]!.date === date ? rows[0]!.close / rows[1]!.close - 1 : null;
  }
  return out;
}
