/* Image generation (GPT Image through Codex or the API) and Viggle Remake:
   the per-project switch and quota, and image jobs that remember what they
   were asked to draw and what came back. */
export default String.raw`
ALTER TABLE projects ADD COLUMN imaging_json TEXT;
ALTER TABLE jobs ADD COLUMN input_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN output_json TEXT;
CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id, created_at);
`;
