import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BRAND, MARK, markSvg } from "@/brand";

/* The name and the mark come from src/brand.ts; docs/brand.md says why. */

describe("the brand", () => {
  it("draws the favicon from the one mark (node scripts/build-brand-assets.mjs)", () => {
    expect(readFileSync("src/app/icon.svg", "utf8")).toBe(`${markSvg({ size: 32, plate: true })}\n`);
  });

  it("puts every line of the mark on whole pixels at 16 px", () => {
    const segments = [...`${MARK.staves}${MARK.here}`.matchAll(/M(\d+) (\d+)([HV])(\d+)/g)];
    expect(segments.length).toBeGreaterThan(0);
    for (const [, x, y, dir, to] of segments) {
      /* a 2-unit stroke is 1 px at 16 px: its centre on an odd unit, its ends on even ones */
      const across = dir === "H" ? Number(y) : Number(x);
      expect(across % 2, `${dir} line at ${across}`).toBe(1);
      expect([dir === "H" ? Number(x) : Number(y), Number(to)].every((n) => n % 2 === 0)).toBe(true);
    }
  });

  it("no longer calls the interface by its old names", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "migrations" ? [] : files(join(dir, e.name))) : /\.(tsx?|css|svg)$/.test(e.name) ? [join(dir, e.name)] : []));
    const old = files("src").filter((f) => /Cinema Studio|OpenHiggsfield|Mr\. Higgs/.test(readFileSync(f, "utf8")));
    expect(old).toEqual([]);
    expect(BRAND.name).toBe("Stave");
  });
});
