// 统一的标的列表：配置文件里的内置标的 + 用户在页面上加的自选。
// 行情刷新、异动检测、归因、页面都从这里取，所以自选会自动走完整流程。
import { ASSETS, type AssetSpec } from "../config/assets.ts";
import { all } from "./db.ts";

interface WatchRow {
  symbol: string;
  name: string;
  short_name: string;
  cls: "stocks" | "etf";
  exchange: string | null;
  added_at: number;
}

/** 自选没有人工写好的关键词，从简称和代码里推：新闻标题里出现它们，就算"直接提到"这个标的。 */
export function specOf(r: WatchRow): AssetSpec {
  const keywords = [r.short_name.toLowerCase()];
  const sym = r.symbol.toLowerCase();
  // 只有 1-2 个字母的代码（F、T、GE）是常用词，当关键词会满屏误伤。
  if (/^[a-z]{3,}$/.test(sym)) keywords.push(sym);
  return {
    symbol: r.symbol,
    name: r.short_name,
    group: "watch",
    // 不知道它和哪条主线有关，四条都看。
    topics: ["macro", "semis", "ai", "energy"],
    keywords,
    newsQuery: r.cls === "etf" ? `${r.symbol} ETF` : `"${r.short_name}" stock`,
    feed: { p: "nasdaq", sym: r.symbol, cls: r.cls },
    note: r.name,
    custom: true,
  };
}

export function watchRows(): WatchRow[] {
  return all<WatchRow>("SELECT * FROM watchlist ORDER BY added_at");
}

export const watchAssets = (): AssetSpec[] => watchRows().map(specOf);
export const allAssets = (): AssetSpec[] => [...ASSETS, ...watchAssets()];
export const findAsset = (symbol: string): AssetSpec | undefined => allAssets().find((a) => a.symbol === symbol);
export const isBuiltin = (symbol: string) => ASSETS.some((a) => a.symbol === symbol);
