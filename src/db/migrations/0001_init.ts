/* Source of truth for migration 0001. `pnpm db:emit` writes the .sql twin that
   `wrangler d1 migrations apply` consumes. */
export default String.raw`
-- Cinema Studio schema (SQLite / D1). Timestamps are unix ms. JSON columns hold
-- validated objects; the app is the only writer.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  look_json TEXT NOT NULL,
  budget_cap_usd REAL NOT NULL DEFAULT 50,
  spent_usd REAL NOT NULL DEFAULT 0,
  shotlist_approval TEXT NOT NULL DEFAULT 'draft',
  shotlist_approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scripts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  approval TEXT NOT NULL DEFAULT 'draft',
  approved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scripts_project ON scripts(project_id, version);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_s REAL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS elements (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ref_asset_ids_json TEXT NOT NULL DEFAULT '[]',
  voice_asset_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS elements_project ON elements(project_id);

CREATE TABLE IF NOT EXISTS scenes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  slug TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  location_element_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scenes_project ON scenes(project_id, idx);

CREATE TABLE IF NOT EXISTS shots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  spec_json TEXT NOT NULL,
  hero_asset_id TEXT,
  end_asset_id TEXT,
  selected_take_id TEXT,
  prompt_override TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS shots_scene ON shots(scene_id, idx);
CREATE INDEX IF NOT EXISTS shots_project ON shots(project_id);

CREATE TABLE IF NOT EXISTS takes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  backend TEXT NOT NULL,
  workflow TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input_json TEXT NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  result_url TEXT,
  last_frame_url TEXT,
  thumb_urls_json TEXT NOT NULL DEFAULT '[]',
  execution_ms INTEGER,
  cost_usd REAL,
  seed INTEGER,
  error TEXT,
  review_json TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS takes_shot ON takes(shot_id, n);
CREATE INDEX IF NOT EXISTS takes_status ON takes(status);
CREATE INDEX IF NOT EXISTS takes_request ON takes(request_id);

CREATE TABLE IF NOT EXISTS timelines (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  timeline_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS export_jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  preset TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  request_id TEXT,
  input_json TEXT NOT NULL,
  result_url TEXT,
  srt_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS export_jobs_project ON export_jobs(project_id);

-- Image-model jobs (hero frames, element refs) that answer with assets.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  backend TEXT NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  asset_ids_json TEXT NOT NULL DEFAULT '[]',
  cost_usd REAL,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);

CREATE TABLE IF NOT EXISTS eval_votes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  take_a TEXT NOT NULL,
  take_b TEXT NOT NULL,
  winner TEXT NOT NULL,
  scores_json TEXT NOT NULL,
  voter TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Minimal OAuth 2.1 authorization server for MCP connectors.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  user TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  user TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;
