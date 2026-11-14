/* "Stop the GPU when everything has rendered": a one-shot switch on the pod, set from the Queue panel and
   cleared when the pod stops (by it or by hand). The Studio also adds the column on first use, so a deploy
   works before this file has been applied on D1; a second ALTER answers "duplicate column". */
export default String.raw`
ALTER TABLE gpu_pods ADD COLUMN stop_when_done INTEGER NOT NULL DEFAULT 0;
`;
