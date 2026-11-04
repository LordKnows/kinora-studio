/* Tier 1 of the director lives on the project: the brief and the target
   running time. */
export default String.raw`
ALTER TABLE projects ADD COLUMN brief TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN target_seconds INTEGER;
`;
