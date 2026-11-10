/* Voice cards: a character's voice as states (age, hoarse, a disguised register), each with a description for the
   prompt and reference audio. project_id NULL = the global library, shared by every project; elements point at a
   card from meta_json.voiceCardId. The Studio also creates the table on first use, so a deploy works before this
   file has been applied. */
export default String.raw`
CREATE TABLE IF NOT EXISTS voice_cards (id TEXT PRIMARY KEY, project_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS voice_cards_project ON voice_cards (project_id);
`;
