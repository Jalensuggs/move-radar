// 对外 HTTP：超时、条件请求（ETag / Last-Modified）、统一的错误。
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

export class FetchError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

export interface FetchResult {
  status: number;
  text: string;
  etag: string | null;
  lastModified: string | null;
  notModified: boolean;
}

export async function fetchText(url: string, opts: { headers?: Record<string, string>; etag?: string | null; lastModified?: string | null; timeoutMs?: number } = {}): Promise<FetchResult> {
  const headers: Record<string, string> = { "user-agent": BROWSER_UA, accept: "*/*", ...opts.headers };
  if (opts.etag) headers["if-none-match"] = opts.etag;
  if (opts.lastModified) headers["if-modified-since"] = opts.lastModified;
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000), redirect: "follow" });
  } catch (error) {
    throw new FetchError(`network: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 304) return { status: 304, text: "", etag: opts.etag ?? null, lastModified: opts.lastModified ?? null, notModified: true };
  if (!res.ok) throw new FetchError(`HTTP ${res.status} ${url.slice(0, 120)}`, res.status);
  return { status: res.status, text: await res.text(), etag: res.headers.get("etag"), lastModified: res.headers.get("last-modified"), notModified: false };
}

export async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const r = await fetchText(url, { headers: { accept: "application/json", ...headers } });
  try {
    return JSON.parse(r.text) as T;
  } catch {
    throw new FetchError(`not JSON: ${url.slice(0, 120)}`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 有限并发地跑一批任务，单个失败不影响其他。 */
export async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<Array<R | Error>> {
  const out: Array<R | Error> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (error) {
        out[i] = error instanceof Error ? error : new Error(String(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}
