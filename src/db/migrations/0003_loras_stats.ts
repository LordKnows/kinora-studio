/* LoRA library + per-take GPU accounting (type, hourly price, output seconds)
   so generation speed and cost can be compared per GPU type. The ALTERs are
   not idempotent in SQLite; the migration runner applies each file once. */
export default String.raw`
CREATE TABLE IF NOT EXISTS loras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  hf_url TEXT,
  trigger_words TEXT NOT NULL DEFAULT '',
  default_strength REAL NOT NULL DEFAULT 1,
  steps_hint INTEGER,
  workflows_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
ALTER TABLE takes ADD COLUMN gpu_type_id TEXT;
ALTER TABLE takes ADD COLUMN gpu_cost_per_hr REAL;
ALTER TABLE takes ADD COLUMN output_seconds REAL;
CREATE INDEX IF NOT EXISTS takes_gpu ON takes(gpu_type_id, status);
`;
