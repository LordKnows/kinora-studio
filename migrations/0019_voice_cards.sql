CREATE TABLE IF NOT EXISTS voice_cards (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS voice_cards_project ON voice_cards (project_id);
CREATE TABLE IF NOT EXISTS voice_settings (project_id TEXT PRIMARY KEY, data_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
