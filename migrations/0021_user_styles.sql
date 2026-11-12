CREATE TABLE IF NOT EXISTS user_styles (slug TEXT PRIMARY KEY, user TEXT NOT NULL, based_on TEXT, style_json TEXT NOT NULL, changes_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS user_styles_user ON user_styles (user, updated_at);
