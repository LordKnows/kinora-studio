/* The director's craft layer: scene colour scripts, element fixed features
   and reference views, stage reviews (story / shot / film) by a cold reader,
   the requirements list and decision log, and the spend envelope the user
   grants on the web for unattended rendering. */
export default String.raw`
ALTER TABLE scenes ADD COLUMN palette_json TEXT;
ALTER TABLE elements ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN autopilot_json TEXT;
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  shot_id TEXT,
  subject_hash TEXT NOT NULL,
  verdict TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  basis TEXT NOT NULL DEFAULT '',
  findings_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_project ON reviews(project_id, stage, created_at);
CREATE INDEX IF NOT EXISTS reviews_shot ON reviews(shot_id, created_at);
CREATE TABLE IF NOT EXISTS director_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS director_notes_project ON director_notes(project_id, kind, created_at);
`;
