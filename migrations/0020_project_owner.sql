ALTER TABLE projects ADD COLUMN owner TEXT;
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
CREATE INDEX IF NOT EXISTS projects_visibility ON projects(visibility, owner);
