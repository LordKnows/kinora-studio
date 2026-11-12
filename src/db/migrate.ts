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
import seedMoreLoras from "./migrations/0007_seed_more_loras";
import takeProgress from "./migrations/0008_take_progress";
import takeUpscale from "./migrations/0009_take_upscale";
import directorCraft from "./migrations/0010_director_craft";
import delegatedApprovals from "./migrations/0011_delegated_approvals";
import imaging from "./migrations/0012_imaging";
import paintersNames from "./migrations/0013_painters_names";
import painterPod from "./migrations/0014_painter_pod";
import userSettings from "./migrations/0015_user_settings";
import loraParams from "./migrations/0016_lora_params";
import seedQwenLoras from "./migrations/0017_seed_qwen_loras";
import userReferences from "./migrations/0018_user_references";
import voiceCards from "./migrations/0019_voice_cards";
import projectOwner from "./migrations/0020_project_owner";

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: "0001_init", sql: init },
  { name: "0002_gpu", sql: gpu },
  { name: "0003_loras_stats", sql: lorasStats },
  { name: "0004_brief", sql: brief },
  { name: "0005_seed_loras", sql: seedLoras },
  { name: "0006_adopted", sql: adopted },
  { name: "0007_seed_more_loras", sql: seedMoreLoras },
  { name: "0008_take_progress", sql: takeProgress },
  { name: "0009_take_upscale", sql: takeUpscale },
  { name: "0010_director_craft", sql: directorCraft },
  { name: "0011_delegated_approvals", sql: delegatedApprovals },
  { name: "0012_imaging", sql: imaging },
  { name: "0013_painters_names", sql: paintersNames },
  { name: "0014_painter_pod", sql: painterPod },
  { name: "0015_user_settings", sql: userSettings },
  { name: "0016_lora_params", sql: loraParams },
  { name: "0017_seed_qwen_loras", sql: seedQwenLoras },
  { name: "0018_user_references", sql: userReferences },
  { name: "0019_voice_cards", sql: voiceCards },
  { name: "0020_project_owner", sql: projectOwner },
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
