/* Pods created by hand in the RunPod console and adopted by the studio: the
   studio starts/stops them but never replaces them. */
export default String.raw`
ALTER TABLE gpu_pods ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;
`;
