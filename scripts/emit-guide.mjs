// agent/director.md is the source; this writes src/mcp/guide.ts so the guide
// ships inside the bundle (no filesystem on Workers). Runs before dev/build.
import { readFileSync, writeFileSync } from "node:fs";

const md = readFileSync(new URL("../agent/director.md", import.meta.url), "utf8");
const out = `/* Generated from agent/director.md by scripts/emit-guide.mjs — do not edit. */\nconst guide: string = ${JSON.stringify(md)};\nexport default guide;\n`;
writeFileSync(new URL("../src/mcp/guide.ts", import.meta.url), out);
console.log("wrote src/mcp/guide.ts");
