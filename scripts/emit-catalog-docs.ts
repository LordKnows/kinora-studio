/* Writes agent/editing.md and agent/cinematography.md from the TypeScript
   catalogs, so the markdown the agent reads and the keys the schema accepts
   can never drift. Run with `pnpm guide:emit`. */
import { writeFileSync } from "node:fs";

import { CINEMA } from "../src/studio/cinematography";
import { EDIT_GRAMMAR, TIMELINE_ONLY } from "../src/studio/editing";
import { editingGuide, cinematographyGuide } from "../src/studio/director-guides";

writeFileSync(new URL("../agent/editing.md", import.meta.url), editingGuide(EDIT_GRAMMAR, TIMELINE_ONLY));
writeFileSync(new URL("../agent/cinematography.md", import.meta.url), cinematographyGuide(CINEMA));
console.log("wrote agent/editing.md and agent/cinematography.md");
