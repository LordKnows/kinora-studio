/* Live progress of a running take (stage, step/total, ETA), as reported by
   the pod's job server. */
export default String.raw`
ALTER TABLE takes ADD COLUMN progress_json TEXT;
`;
