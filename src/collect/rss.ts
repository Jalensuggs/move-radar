// RSS 2.0 / Atom / RDF 解析。Google News 的条目有 guid 和 <source>，标题带 " - 媒体名" 后缀。
import { XMLParser } from "fast-xml-parser";
import { collapse, stripTags } from "../lib/text.ts";

export interface Candidate {
  /** 稳定身份（Google News 用 guid），没有就按 URL。 */
  key: string | null;
  url: string;
  title: string;
  publisher: string | null;
  excerpt: string | null;
  publishedAt: number | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("#cdata" in o) return text(o["#cdata"]);
    if ("#text" in o) return text(o["#text"]);
  }
  return "";
}

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function atomLink(links: unknown): string {
  for (const l of arr(links as Record<string, string> | Array<Record<string, string>>)) {
    if (typeof l === "string") return l;
    if (!l["@rel"] || l["@rel"] === "alternate") return l["@href"] ?? "";
  }
  return "";
}

function parseDate(v: string): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function gnewsUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

export function parseFeed(xml: string, opts: { google?: boolean; publisher?: string } = {}): Candidate[] {
  const doc = parser.parse(xml) as Record<string, any>;
  const items: Array<Record<string, unknown>> = [
    ...arr(doc?.rss?.channel?.item),
    ...arr(doc?.feed?.entry),
    ...arr(doc?.["rdf:RDF"]?.item),
  ];
  const out: Candidate[] = [];
  for (const it of items) {
    let title = stripTags(text(it.title));
    const link = typeof it.link === "object" && !Array.isArray(it.link) && it.link !== null && "@href" in (it.link as object)
      ? atomLink(it.link)
      : Array.isArray(it.link) ? atomLink(it.link) : text(it.link);
    if (!title || !link) continue;
    const source = it.source as Record<string, string> | string | undefined;
    let publisher = typeof source === "object" ? collapse(source["#text"] ?? "") || null : typeof source === "string" ? source : null;
    publisher ??= opts.publisher ?? null;
    if (opts.google && publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3)).trim();
    let excerpt = stripTags(text(it.description ?? it.summary ?? it.content ?? it["content:encoded"])) || null;
    // Google News 的 description 只是"标题 + 媒体名"，没有信息量。
    if (opts.google || (excerpt && excerpt.startsWith(title.slice(0, 40)))) excerpt = null;
    const guid = text(it.guid ?? it.id);
    out.push({
      key: opts.google && guid ? `gn:${guid}` : null,
      url: link,
      title,
      publisher,
      excerpt: excerpt ? excerpt.slice(0, 600) : null,
      publishedAt: parseDate(text(it.pubDate ?? it.published ?? it.updated ?? it["dc:date"])),
    });
  }
  return out;
}
