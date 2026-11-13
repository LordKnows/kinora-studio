CREATE TABLE IF NOT EXISTS voice_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT, status TEXT NOT NULL, backend_job_id TEXT, data_json TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS voice_jobs_project ON voice_jobs (project_id, created_at);
CREATE INDEX IF NOT EXISTS voice_jobs_status ON voice_jobs (status);
