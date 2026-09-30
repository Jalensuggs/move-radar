import { createHash } from "node:crypto";

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'", "&nbsp;": " " };
export function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export const stripTags = (html: string) => collapse(decodeEntities(html.replace(/<[^>]+>/g, " ")));

/** 去掉跟踪参数、锚点、结尾斜杠，host 小写。 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|oc$)/i.test(k)) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

const STOP = new Set(("a an the and or of to in on for at by with from as is are was were be been it its this that these those after before over under " +
  "into about amid says said say new more than up down vs via how why what who will would could can may might has have had not no just " +
  "stock stocks shares share market markets report reports today week year").split(" "));

/** 标题的关键词集合，用于词法相似度（规则模式的聚簇召回）。 */
export function tokens(text: string): string[] {
  const words = text.toLowerCase().replace(/['’]s\b/g, "").replace(/[^a-z0-9$%.\- ]+/g, " ").split(/\s+/);
  const out = new Set<string>();
  for (let w of words) {
    w = w.replace(/^[.\-]+|[.\-]+$/g, "");
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    out.add(w);
  }
  return [...out];
}

/**
 * 两个标题像不像：Jaccard 对"同一件事换个说法"太严格，所以再看重叠系数（交集 ÷ 较短的一方），
 * 同时要求至少 3 个共同关键词，避免"Nvidia 涨了" 和 "Nvidia 跌了" 这种只共享公司名的被并到一起。
 */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of a) if (sb.has(x)) inter++;
  const jac = inter / (a.length + b.length - inter);
  const overlap = inter >= 3 ? inter / Math.min(a.length, b.length) : 0;
  return Math.max(jac, overlap * 0.75);
}

/** 美东日期（美股交易日）。 */
const ET = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
export const etDate = (ms: number) => ET.format(new Date(ms));

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
