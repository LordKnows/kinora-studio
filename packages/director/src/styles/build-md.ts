import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadStyles, libraryDir } from "./index.js";
import { styleToMarkdown } from "./markdown.js";

const styles = loadStyles().filter((s) => s.origin === "library");
for (const { style, dir } of styles) {
  writeFileSync(join(dir, "STYLE.md"), styleToMarkdown(style));
}
const index = [
  "# Style index · 风格索引",
  "",
  "Generated from `styles/*/style.json`. Name a style by slug, English or Chinese name.",
  "",
  "| Style | 风格 | Slug | Category | Uses |",
  "|---|---|---|---|---|",
  ...styles.map(({ style: s }) => `| [${s.en}](${s.slug}/STYLE.md) | ${s.cn} | \`${s.slug}\` | ${s.category} | ${s.uses.join(", ")} |`),
  "",
].join("\n");
writeFileSync(join(libraryDir(), "README.md"), index);
console.log(`wrote ${styles.length} STYLE.md files and README.md`);
