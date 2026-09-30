// SQLite（Node 自带的 node:sqlite），一个文件就是整个数据库。
// AIHOT 用 PostgreSQL + pg-boss；这里规模小，用"状态列 + 定时扫描"代替任务队列，思路相同。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.DB_FILE ?? path.join(root, "data", "radar.db");
mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  topic TEXT NOT NULL,
  target TEXT NOT NULL,
  first_party INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_min INTEGER NOT NULL,
  next_fetch_at INTEGER,
  last_fetch_at INTEGER,
  last_ok_at INTEGER,
  fail_count INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'new',
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  initialized INTEGER NOT NULL DEFAULT 0
);

-- 资料。所有入口都经过 ingest.ts，identity_key 决定"是不是同一条"。
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE,
  title_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT,
  excerpt TEXT,
  published_at INTEGER,
  discovered_at INTEGER NOT NULL,
  timeline_at INTEGER NOT NULL,
  backfill INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'new',          -- new | judged | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER,
  error TEXT,
  mode TEXT,                                   -- llm | rules
  relevant INTEGER,
  importance INTEGER,
  score1 INTEGER,
  score2 INTEGER,
  selected INTEGER NOT NULL DEFAULT 0,
  title_zh TEXT,
  summary_zh TEXT,
  entities TEXT,
  event_id INTEGER,
  judged_at INTEGER
);
CREATE INDEX IF NOT EXISTS articles_state ON articles(state, retry_at);
CREATE INDEX IF NOT EXISTS articles_timeline ON articles(timeline_at);
CREATE INDEX IF NOT EXISTS articles_event ON articles(event_id);
CREATE INDEX IF NOT EXISTS articles_title_key ON articles(title_key);

-- 事件：不同来源说的同一件事。
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  title_zh TEXT,
  tokens TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  best_importance INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS events_last ON events(last_at);

CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  close REAL NOT NULL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS fear_greed (
  date TEXT PRIMARY KEY,
  score REAL NOT NULL,
  rating TEXT
);

-- 异动：日收益相对过去 60 个交易日波动率的 z 分数超过阈值。
CREATE TABLE IF NOT EXISTS moves (
  symbol TEXT NOT NULL,
  date TEXT NOT NULL,
  ret REAL NOT NULL,
  z REAL NOT NULL,
  close REAL NOT NULL,
  forced INTEGER NOT NULL DEFAULT 0,
  backfilled_at INTEGER,
  attribution TEXT,
  attributed_at INTEGER,
  PRIMARY KEY (symbol, date)
);

-- 付费请求回执：先记账再发请求，拿到结果先存再用；重试和重启复用已付费的结果。
CREATE TABLE IF NOT EXISTS receipts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  service TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,                        -- pending | ok | failed
  response TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS receipts_created ON receipts(service, created_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  detail TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

type Params = SQLInputValue[];

export function all<T>(sql: string, ...params: Params): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T>(sql: string, ...params: Params): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(sql: string, ...params: Params) {
  return db.prepare(sql).run(...params);
}
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function setKv(key: string, value: unknown) {
  run("INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key, JSON.stringify(value), Date.now());
}
export function getKv<T>(key: string): { value: T; updatedAt: number } | null {
  const row = get<{ value: string; updated_at: number }>("SELECT value, updated_at FROM kv WHERE key = ?", key);
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null;
}

/** 每次定时任务留一行记录，页面上能看到最近一次的结果。 */
export async function recordRun<T>(job: string, fn: () => Promise<T>): Promise<T> {
  const id = Number(run("INSERT INTO runs (job, started_at) VALUES (?, ?)", job, Date.now()).lastInsertRowid);
  try {
    const result = await fn();
    run("UPDATE runs SET status = 'ok', finished_at = ?, detail = ? WHERE id = ?", Date.now(), JSON.stringify(result ?? null).slice(0, 4000), id);
    return result;
  } catch (error) {
    run("UPDATE runs SET status = 'failed', finished_at = ?, detail = ? WHERE id = ?", Date.now(), String(error).slice(0, 4000), id);
    throw error;
  }
}
