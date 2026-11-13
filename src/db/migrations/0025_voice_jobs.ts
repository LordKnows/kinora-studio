/* Voice jobs: one line spoken several times on the GPU pod (Qwen3-TTS
   VoiceDesign, one take per seed) for the user to pick from. data_json holds
   the request (text, the voice description, seeds, the card, the line it is
   for), the takes as they came back (R2 key, seed, length, closeness to the
   card's reference, what the pronunciation check heard) and which take was
   picked. The Studio also creates the table on first use, so a deploy works
   before this file has been applied on D1. */
export default String.raw`
CREATE TABLE IF NOT EXISTS voice_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, shot_id TEXT, status TEXT NOT NULL, backend_job_id TEXT, data_json TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS voice_jobs_project ON voice_jobs (project_id, created_at);
CREATE INDEX IF NOT EXISTS voice_jobs_status ON voice_jobs (status);
`;
