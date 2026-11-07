ALTER TABLE projects ADD COLUMN imaging_json TEXT;
ALTER TABLE jobs ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN output_json TEXT;
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
