import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BRAND, MARK, faviconSvg, markSvg } from "@/brand";

/* The name and the mark come from src/brand.ts; docs/brand.md says why. */

describe("the brand", () => {
  it("draws the favicon from the one mark (node scripts/build-brand-assets.mjs)", () => {
    expect(readFileSync("src/app/icon.svg", "utf8")).toBe(`${faviconSvg()}\n`);
  });

  it("is three cards, one red, on every ground", () => {
    expect(MARK.cards.filter((c) => c.red)).toHaveLength(1);
    for (const ground of ["ink", "paper", "night", "none"] as const) {
      const svg = markSvg({ ground });
      expect(svg.match(/<rect [^>]*rx="3.5"/g), ground).toHaveLength(3);
      expect(svg, ground).toContain("#FF4B1F");
    }
    /* the favicon turns to the raised dark plate in a dark browser */
    expect(faviconSvg()).toContain("prefers-color-scheme: dark");
  });

  it("spells its wordmark from the word, the i carrying the red card", () => {
    expect(BRAND.word.includes("i")).toBe(true);
    expect(`${BRAND.word} ${BRAND.suffix}`.toLowerCase()).toBe(BRAND.name.toLowerCase());
  });

  it("no longer calls the interface by its earlier names", () => {
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "migrations" ? [] : files(join(dir, e.name))) : /\.(tsx?|css|svg)$/.test(e.name) ? [join(dir, e.name)] : []));
    const old = files("src").filter((f) => /Cinema Studio|OpenHiggsfield|Mr\. Higgs|镜谱|>Stave</.test(readFileSync(f, "utf8")));
    expect(old).toEqual([]);
  });
});

describe("the installed app and the sitemap", () => {
  it("the manifest names the brand, and every icon it lists is a file the build wrote", async () => {
    const { existsSync } = await import("node:fs");
    const { BRAND, BRAND_COLORS } = await import("@/brand");
    const { default: manifest } = await import("@/app/manifest");
    const m = manifest();
    expect(m.name).toBe(`${BRAND.name} ${BRAND.zh}`);
    expect(m.theme_color).toBe(BRAND_COLORS.card);
    for (const icon of m.icons ?? []) expect(existsSync(icon.src === "/icon.svg" ? "src/app/icon.svg" : `public${icon.src}`), icon.src).toBe(true);
    expect(m.icons?.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("the sitemap lists only the front door, and nothing from the old project is left in public/", async () => {
    const { existsSync } = await import("node:fs");
    const { default: sitemap } = await import("@/app/sitemap");
    expect(sitemap().map((e) => new URL(e.url).pathname)).toEqual(["/"]);
    expect(existsSync("public/model-icons")).toBe(false);
  });
});
