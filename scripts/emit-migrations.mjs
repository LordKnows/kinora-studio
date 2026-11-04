// Writes src/db/migrations/*.ts (the source of truth) out as .sql files under
// migrations/ for `wrangler d1 migrations apply`.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dir = new URL("../src/db/migrations/", import.meta.url);
mkdirSync(new URL("../migrations/", import.meta.url), { recursive: true });
for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
  const mod = await import(pathToFileURL(new URL(file, dir).pathname).href);
  const out = new URL(`../migrations/${file.replace(/\.ts$/, ".sql")}`, import.meta.url);
  writeFileSync(out, mod.default.trim() + "\n");
  console.log("wrote", out.pathname);
}
