import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkConstraint, lintConstraints, promptConstraints } from "@director/lint/constraints";
import { LookSettings } from "@/studio/schemas";

describe("the Look's constraints on a model with no negative prompt", () => {
  it("keeps a statement of what the picture shows", () => {
    for (const text of ["exactly two people in the room", "the street is empty", "sharp focus, crisp detail", "film grain", "both hands rest on the table", "画面里只有两个人", "无人机掠过屋顶"]) {
      expect(checkConstraint(text)).toMatchObject({ kind: "ok", inPrompt: true });
    }
  });

  it("leaves a bare negative-prompt word out of the prompt and says what to write", () => {
    for (const text of ["blurry", "lowres", "plastic skin", "over-smoothed", "cartoon", "anime", "illustration", "Blurry.", "lowres, blurry", "worst quality, bad anatomy", "模糊", "卡通"]) {
      expect(checkConstraint(text)).toMatchObject({ kind: "bare", inPrompt: false });
    }
    expect(checkConstraint("blurry").suggest).toContain("sharp focus");
    expect(checkConstraint("plastic skin").suggest).toContain("natural skin texture");
    expect(checkConstraint("anime").suggest).toContain("medium");
  });

  it("leaves a ban on text out: H3 draws only text a prompt quotes", () => {
    for (const text of ["no on-screen text", "no logos", "no subtitles", "No watermark", "text", "logos", "without captions", "不要字幕", "无水印", "text, logos"]) {
      const v = checkConstraint(text);
      expect(v.inPrompt).toBe(false);
      expect(["text_ban", "bare"]).toContain(v.kind);
    }
    expect(checkConstraint("no subtitles").kind).toBe("text_ban");
  });

  it("keeps any other ban as written and asks for the positive form", () => {
    expect(checkConstraint("no extra people")).toMatchObject({ kind: "ban", inPrompt: true });
    expect(checkConstraint("no extra people").suggest).toContain("exactly two people");
    expect(checkConstraint("no handheld shake").suggest).toContain("locked-off");
    expect(checkConstraint("no blurry frames").suggest).toContain("sharp focus");
    expect(checkConstraint("不要多余的人")).toMatchObject({ kind: "ban", inPrompt: true });
    expect(checkConstraint("no glossy plastic").suggest).toContain("what the picture shows");
  });

  it("splits a list into what the prompt carries and what it does not", () => {
    const { keep, dropped } = promptConstraints(["cartoon", "anime", "lowres", "blurry", "plastic skin", "text", "logos", "the bedroom has one lamp", "no rain", " "]);
    expect(keep).toEqual(["the bedroom has one lamp", "no rain"]);
    expect(dropped.map((d) => d.text)).toEqual(["cartoon", "anime", "lowres", "blurry", "plastic skin", "text", "logos"]);
  });

  it("lints one finding per kind, each entry with its positive form", () => {
    const lint = lintConstraints(["blurry", "no subtitles", "no extra people", "the street is empty"]);
    expect(lint.map((w) => [w.code, w.severity])).toEqual([["look.constraints.bare", "warn"], ["look.constraints.text", "info"], ["look.constraints.ban", "info"]]);
    expect(lint[0]!.message).toContain('"blurry" → ');
    expect(lint[2]!.message).toContain('"no extra people" → ');
    expect(lintConstraints(["the street is empty"])).toEqual([]);
    expect(lintConstraints([])).toEqual([]);
  });

  it("every style preset's constraints are statements: none is a ban, a bare word or a text ban", () => {
    const dir = join(__dirname, "../packages/director/styles");
    const slugs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_")).map((d) => d.name);
    expect(slugs.length).toBe(16);
    for (const slug of slugs) {
      const list = JSON.parse(readFileSync(join(dir, slug, "style.json"), "utf8")).engine.negative as string[];
      expect(list.length, slug).toBeGreaterThan(0);
      for (const text of list) {
        expect(checkConstraint(text), `${slug}: ${text}`).toMatchObject({ kind: "ok", inPrompt: true });
        expect(text, `${slug}: ${text}`).not.toMatch(/\b(no|not|never|without|avoid|don't)\b/i);
      }
      expect(lintConstraints(list), slug).toEqual([]);
    }
  });

  it("a new Look starts with no constraints", () => {
    expect(LookSettings.parse({ genre: "", palette: "", camera: "", lens: "", lighting: "" }).negative).toEqual([]);
  });
});
