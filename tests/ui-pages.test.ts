import { describe, expect, it } from "vitest";

/* The project's pages after the reorganisation: five in the bar (Reel, Story,
   Design, Board, Cut), each with an icon, and the old addresses landing on
   the page that holds them now. */

describe("the project bar", () => {
  it("has the five pages in working order, each with its icon", async () => {
    const { PROJECT_NAV } = await import("@/studio-ui/shell");
    const { NAV_ICON_NAMES } = await import("@/studio-ui/nav-icons");
    expect(PROJECT_NAV.map((p) => p.slug)).toEqual(["", "story", "design", "board", "cut"]);
    expect(PROJECT_NAV.map((p) => p.label)).toEqual(["Reel", "Story", "Design", "Board", "Cut"]);
    for (const p of PROJECT_NAV) expect(NAV_ICON_NAMES).toContain(p.icon);
    /* and the three tools beside them */
    for (const tool of ["screen", "director", "settings"]) expect(NAV_ICON_NAMES).toContain(tool);
  });
});

describe("the old addresses", () => {
  it("are redirected before rendering, to the page that holds them now", async () => {
    const { default: config } = await import("../next.config");
    const rules = await config.redirects!();
    const to = Object.fromEntries(rules.map((r) => [r.source, r.destination]));
    expect(to).toEqual({
      "/p/:id/look": "/p/:id/design",
      "/p/:id/script": "/p/:id/story",
      "/p/:id/elements": "/p/:id/design?tab=elements",
      "/p/:id/pictures": "/p/:id/design?tab=pictures",
      "/p/:id/timeline": "/p/:id/cut",
      "/p/:id/finals": "/p/:id/cut",
      "/p/:id/director": "/p/:id?panel=director",
      "/p/:id/settings": "/p/:id?panel=settings",
    });
    expect(rules.every((r) => r.permanent === false)).toBe(true);
  });

  it("have no pages of their own any more", async () => {
    const { existsSync } = await import("node:fs");
    for (const old of ["look", "script", "elements", "pictures", "timeline", "finals", "director", "settings"]) expect(existsSync(`src/app/p/[id]/${old}`), old).toBe(false);
  });
});

describe("what waits for you", () => {
  it("points only at the new pages", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/studio-ui/needs.ts", "src/studio-ui/score-page.tsx", "src/studio-ui/problems-list.tsx", "src/studio-ui/common.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\$\{base\}\/(look|script|elements|pictures|timeline|director)\b|\/p\/\$\{projectId\}\/(script|timeline)\b/);
    }
  });
});

describe("LoRAs are per shot", () => {
  it("the Look tab picks none; the shot editor shows the two switches and what the director assigned", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/studio-ui/look-page.tsx", "utf8")).not.toMatch(/LoraPicker|loras/);
    const editor = readFileSync("src/studio-ui/shot-editor.tsx", "utf8");
    expect(editor).toContain("<ShotLorasField");
    expect(editor).not.toContain("LoraPicker");
    const field = readFileSync("src/studio-ui/shot-loras-field.tsx", "utf8");
    for (const s of ['"Use turbo"', '"Use LoRA"', "useTurbo", "useLoras"]) expect(field).toContain(s);
  });

  it("a shot card names the LoRAs it loads, strikes them while use LoRA is off, and says when turbo is off", async () => {
    const { shotLoraChips } = await import("@/studio-ui/shot-loras-field");
    const library = [
      { id: "t", name: "Turbo", kind: "speed", workflows: ["T2VA"] },
      { id: "r", name: "Realism", kind: "style", workflows: [] },
    ] as never;
    const spec = { mode: "text" as const, loras: [{ id: "r", why: "faces" }, { id: "t" }] };
    expect(shotLoraChips(spec, library)).toEqual([{ key: "r", label: "Realism", off: false, title: "faces" }]);
    expect(shotLoraChips({ ...spec, useLoras: false, useTurbo: false }, library)).toEqual([{ key: "turbo", label: "no turbo" }, { key: "r", label: "Realism", off: true, title: "faces" }]);
  });
});
