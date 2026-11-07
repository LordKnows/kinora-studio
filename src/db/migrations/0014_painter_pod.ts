/* The painter's own pod: a RunPod CPU pod the Studio takes over by id, starts
   when pictures are queued and nobody can draw them, and stops after idling,
   like the GPU pod. One row is the current one. */
export default String.raw`
CREATE TABLE IF NOT EXISTS painter_pods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  message TEXT,
  cost_per_hr REAL,
  started_at INTEGER,
  stopped_at INTEGER,
  last_activity_at INTEGER,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;
