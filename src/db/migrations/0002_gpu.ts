/* GPU pod lifecycle (RunPod Pod mode). One row per pod the studio created;
   the newest non-terminated row is "the" GPU. */
export default String.raw`
CREATE TABLE IF NOT EXISTS gpu_pods (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  image TEXT NOT NULL,
  gpu_type_id TEXT,
  gpu_name TEXT,
  data_center TEXT,
  status TEXT NOT NULL,
  message TEXT,
  cost_per_hr REAL,
  host_url TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  stopped_at INTEGER,
  accumulated_seconds INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS gpu_pods_status ON gpu_pods(status, updated_at);
`;
