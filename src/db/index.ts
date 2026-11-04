/* One tiny async SQL surface over two drivers: better-sqlite3 on Node (dev,
   tests, self-hosted) and Cloudflare D1 on Workers. Both speak the same SQLite
   dialect with `?` placeholders, so the app never sees the difference. */

export type SqlValue = string | number | null | bigint | Uint8Array;

export interface Db {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
}

type D1Like = {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
  exec(sql: string): Promise<unknown>;
};

export function d1Db(d1: D1Like): Db {
  return {
    async all<T>(sql: string, params: SqlValue[] = []) {
      const { results } = await d1.prepare(sql).bind(...params).all<T>();
      return results;
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      const row = await d1.prepare(sql).bind(...params).first<T>();
      return row ?? undefined;
    },
    async run(sql: string, params: SqlValue[] = []) {
      const { meta } = await d1.prepare(sql).bind(...params).run();
      return { changes: meta.changes };
    },
    async exec(sql: string) {
      await d1.exec(sql);
    },
  };
}

let nodeDb: Db | null = null;

async function openNodeDb(): Promise<Db> {
  if (nodeDb) return nodeDb;
  const path = process.env.DATABASE_PATH ?? ".data/studio.sqlite";
  const { default: Database } = await import("better-sqlite3");
  const fs = await import("node:fs");
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && path !== ":memory:") fs.mkdirSync(dir, { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db: Db = {
    async all<T>(sql: string, params: SqlValue[] = []) {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    async get<T>(sql: string, params: SqlValue[] = []) {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
    async run(sql: string, params: SqlValue[] = []) {
      const info = sqlite.prepare(sql).run(...params);
      return { changes: Number(info.changes) };
    },
    async exec(sql: string) {
      sqlite.exec(sql);
    },
  };
  const { migrate } = await import("./migrate");
  await migrate(db);
  nodeDb = db;
  return db;
}

/** Tests and scripts can hand the app a database of their own. */
let override: Db | null = null;
export function setDb(db: Db | null): void {
  override = db;
}

export async function getDb(): Promise<Db> {
  if (override) return override;
  if (process.env.STUDIO_DB === "d1") {
    const { bindD1 } = await import("@/cloudflare");
    const d1 = (await bindD1()) as D1Like | null;
    if (!d1) throw new Error("STUDIO_DB=d1 but no DB binding is attached");
    return d1Db(d1);
  }
  return openNodeDb();
}
