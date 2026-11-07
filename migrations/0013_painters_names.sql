CREATE TABLE IF NOT EXISTS painters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  info_json TEXT NOT NULL DEFAULT '{}',
  commands_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
ALTER TABLE jobs ADD COLUMN claimed_at INTEGER;
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN seq INTEGER;
ALTER TABLE assets ADD COLUMN name TEXT;
UPDATE assets SET seq = (
  SELECT COUNT(*) FROM assets a2
  WHERE a2.kind = 'image' AND a2.project_id = assets.project_id
    AND (a2.created_at < assets.created_at OR (a2.created_at = assets.created_at AND a2.id <= assets.id))
) WHERE kind = 'image' AND project_id IS NOT NULL;
ALTER TABLE projects ADD COLUMN picture_seq INTEGER NOT NULL DEFAULT 0;
UPDATE projects SET picture_seq = COALESCE((SELECT MAX(seq) FROM assets WHERE assets.project_id = projects.id AND kind = 'image'), 0);
UPDATE assets SET name = json_extract(meta_json, '$.label') WHERE kind = 'image' AND name IS NULL AND json_extract(meta_json, '$.label') IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_project_seq ON assets(project_id, seq);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created_at);
