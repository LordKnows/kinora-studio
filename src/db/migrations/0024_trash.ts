/* What a delete removed, kept for a while so it can be put back (trash.ts):
   a shot, a scene, an element, some pictures or a whole project, as the rows
   they were, plus what the delete changed elsewhere. No foreign key to
   projects: a deleted project's own entry has to outlive it. The Studio also
   creates the table on first use, so a deploy works before this file has
   been applied on D1. */
export default String.raw`
CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, project_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL, payload_json TEXT NOT NULL, by_user TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, restored_at INTEGER);
CREATE INDEX IF NOT EXISTS trash_project ON trash(project_id, created_at);
`;
