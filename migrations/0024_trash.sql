CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, payload_json TEXT NOT NULL, by_user TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, restored_at INTEGER);
CREATE INDEX IF NOT EXISTS trash_project ON trash(project_id, created_at);
