import type { Db } from "./index";

/* Migrations live as plain SQL so the same files run through `wrangler d1
   migrations apply` on Cloudflare and through this function on Node. Every
   statement is written to be re-runnable (IF NOT EXISTS), and applied files
   are recorded so later ones can carry real ALTERs. */

import init from "./migrations/0001_init";
import gpu from "./migrations/0002_gpu";
import lorasStats from "./migrations/0003_loras_stats";
import brief from "./migrations/0004_brief";
import seedLoras from "./migrations/0005_seed_loras";
import adopted from "./migrations/0006_adopted";

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: "0001_init", sql: init },
  { name: "0002_gpu", sql: gpu },
  { name: "0003_loras_stats", sql: lorasStats },
  { name: "0004_brief", sql: brief },
  { name: "0005_seed_loras", sql: seedLoras },
  { name: "0006_adopted", sql: adopted },
];

export async function migrate(db: Db): Promise<void> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  for (const { name, sql } of MIGRATIONS) {
    const done = await db.get("SELECT name FROM schema_migrations WHERE name = ?", [name]);
    if (done) continue;
    await db.exec(sql);
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [name, Date.now()]);
  }
}
