/* "Stop the GPU when everything has rendered": a one-shot switch on the pod, set from the Queue panel and
   cleared when the pod stops (by it or by hand). */
export default String.raw`
ALTER TABLE gpu_pods ADD COLUMN stop_when_done INTEGER NOT NULL DEFAULT 0;
`;
