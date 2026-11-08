CREATE TABLE IF NOT EXISTS user_settings (user TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL);
