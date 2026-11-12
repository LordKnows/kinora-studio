import { describe, expect, it } from "vitest";

import type { ProjectView } from "@/studio/orchestrator";
import { clipSeconds, filmSeconds, filmShots, pipState, seamTrims, tc } from "@/studio-ui/film";
import { translate } from "@/studio-ui/i18n";
import { needsOf, nextStep } from "@/studio-ui/needs";
import { diffSentences, scriptSections } from "@/studio-ui/script-text";

/* The Score's pure parts: the film as one line of time, the seams of the cut,
   what waits for the person, the script's sections and changes, the
   translator. A small film: two scenes, three shots, 3·… none. */

type TakeLike = { id: string; n: number; status: string; outputSeconds?: number; review?: { score: number }; costUsd?: number; thumbUrls: string[]; error?: string };
const take = (id: string, n: number, status = "completed", extra: Partial<TakeLike> = {}): TakeLike => ({ id, n, status, thumbUrls: [], ...extra });

function film(over: { picked?: Record<string, string | undefined>; reviewed?: string[]; clips?: Array<{ shotId: string; takeId: string; inS: number; outS: number }>; assets?: unknown[]; script?: unknown; approval?: string } = {}): ProjectView {
  const reviewed = new Set(over.reviewed ?? []);
  const t = (id: string, n: number, status = "completed", extra: Partial<TakeLike> = {}) => take(id, n, status, { ...extra, ...(reviewed.has(id) ? { review: { score: 4 } } : {}) });
  const takes: Record<string, TakeLike[]> = {
    a1: [t("a1t2", 2, "completed", { outputSeconds: 5.17, costUsd: 0.07 }), t("a1t1", 1, "failed", { error: "boom", costUsd: 0.001 })],
    a2: [t("a2t1", 1, "completed", { outputSeconds: 5.17, costUsd: 0.07 })],
    b1: [t("b1t1", 1, "completed", { outputSeconds: 10.13, costUsd: 0.18 })],
  };
  const picked = { a1: "a1t2", a2: "a2t1", b1: "b1t1", ...over.picked };
  const shot = (id: string, sceneId: string, index: number, durationS: number, link: string) => {
    const ts = takes[id]!;
    const sel = picked[id as keyof typeof picked];
    return { id, sceneId, index, updatedAt: 1, selectedTakeId: sel, selectedTake: ts.find((x) => x.id === sel), takes: ts, spec: { durationS, intent: `shot ${id}`, link: { type: link }, linkToPrev: link === "continuous" ? "continuous" : "cut" } };
  };
  return {
    project: { id: "p", name: "Test", budgetCapUsd: 10, spentUsd: 0.32, targetSeconds: 20, shotlistApproval: over.approval ?? "approved", look: { aspectRatio: "16:9", resolution: "768p" }, updatedAt: 1 },
    script: over.script === undefined ? { id: "s", version: 1, text: "x", approval: "approved" } : over.script,
    elements: [],
    scenes: [
      { id: "sa", slug: "alley", index: 0, summary: "", shots: [shot("a1", "sa", 0, 5, "cut"), shot("a2", "sa", 1, 5, "continuous")] },
      { id: "sb", slug: "roof", index: 1, summary: "", shots: [shot("b1", "sb", 0, 10, "cut")] },
    ],
    timeline: { clips: (over.clips ?? [{ shotId: "a1", takeId: "a1t2", inS: 0, outS: 5 }, { shotId: "a2", takeId: "a2t1", inS: 0, outS: 5 }, { shotId: "b1", takeId: "b1t1", inS: 0, outS: 10 }]).map((c) => ({ transition: "cut", repeat: 1, speed: 1, muteOwnAudio: false, ...c })), mix: { dialogueDb: 0, sfxDb: -3, musicDb: -12 } },
    assets: over.assets ?? [],
    canGenerate: true, blockers: [], delegated: { script: false, shotlist: false },
  } as unknown as ProjectView;
}

describe("the film as one line of time", () => {
  it("numbers shots like a slate and lays them end to end", () => {
    const shots = filmShots(film());
    expect(shots.map((s) => s.slate)).toEqual(["1·1", "1·2", "2·1"]);
    expect(shots.map((s) => s.startS)).toEqual([0, 5, 10]);
    expect(shots.map((s) => s.linkIn)).toEqual(["cut", "continuous", "cut"]);
    expect(filmSeconds(shots)).toBe(20);
    expect(shots[0]!.firstOfScene && !shots[1]!.firstOfScene && shots[2]!.firstOfScene).toBe(true);
  });

  it("writes time codes, with tenths only when asked", () => {
    expect(tc(0)).toBe("0:00");
    expect(tc(59.6)).toBe("1:00");
    expect(tc(31.5, true)).toBe("0:31.5");
    expect(tc(60.67, true)).toBe("1:00.7");
    expect(tc(125)).toBe("2:05");
  });

  it("marks each take as the camera report would", () => {
    const [a1] = filmShots(film());
    const [newest, oldest] = a1!.shot.takes;
    expect(pipState(newest!, a1!.picked?.id)).toBe("circled");
    expect(pipState(oldest!, a1!.picked?.id)).toBe("ng");
  });

  it("counts a clip's held frame, speed and repeats in its length on the film", () => {
    expect(clipSeconds({ shotId: "x", takeId: "y", inS: 1, outS: 5, transition: "cut", repeat: 2, speed: 2, muteOwnAudio: false, freezeS: 1 })).toBe(5);
  });
});

describe("seams of the cut", () => {
  it("finds a continuous join whose anchor the cut leaves before its last frame", () => {
    const v = film();
    const seams = seamTrims(filmShots(v), v.timeline);
    expect(seams).toHaveLength(1);
    expect(seams[0]).toMatchObject({ clipIndex: 0, anchorSlate: "1·1", slate: "1·2", cutAtS: 5, takeEndS: 5.17 });
    expect(seams[0]!.gapS).toBeCloseTo(0.17, 5);
  });

  it("is quiet once the anchor runs to its last frame", () => {
    const v = film({ clips: [{ shotId: "a1", takeId: "a1t2", inS: 0, outS: 5.17 }, { shotId: "a2", takeId: "a2t1", inS: 0, outS: 5 }] });
    expect(seamTrims(filmShots(v), v.timeline)).toEqual([]);
  });
});

describe("what waits for the person", () => {
  const lint = (codes: string[]) => ({ warnings: codes.map((code) => ({ code, message: code, severity: "warn" as const })), counts: { error: 0, warn: codes.length, info: 0 } });

  it("lists unreviewed circled takes, seams and pictures, with where to go", () => {
    const v = film({ reviewed: ["a1t2"], assets: [{ id: "i1", kind: "image", seq: 7, meta: { review: "pending" } }, { id: "i2", kind: "image", seq: 9, meta: { review: "pending" } }] });
    const needs = needsOf(v, lint(["seam.trim"]), "/p/p");
    expect(needs.map((n) => [n.key, n.count])).toEqual([["seams", 1], ["unreviewed", 2], ["pictures", 2]]);
    expect(needs.find((n) => n.key === "unreviewed")!.action.href).toBe("/p/p/screening?shot=a2");
    expect(needs.find((n) => n.key === "pictures")!.detail).toContain("IMG-7–IMG-9");
  });

  it("asks for approvals before anything else and points the red button at the next step", () => {
    expect(nextStep(film({ script: null }), "/p/p").label).toBe("Write the script");
    expect(nextStep(film({ approval: "draft" }), "/p/p").label).toBe("Approve the shotlist");
    expect(nextStep(film({ reviewed: ["a1t2", "a2t1", "b1t1"] }), "/p/p").label).toBe("Cut and export");
    expect(needsOf(film({ approval: "draft" }), null, "/p/p")[0]!.key).toBe("shotlist");
  });

  it("says a shot whose takes all failed has nothing in the cut", () => {
    const v = film({ picked: { a1: undefined } });
    v.scenes[0]!.shots[0]!.takes.reverse(); /* newest first: the failure */
    expect(needsOf(v, null, "/p/p").find((n) => n.key === "failed")?.detail).toContain("1·1");
  });

  it("speaks Chinese when asked, and English for what it does not know", () => {
    const zh = translate("zh");
    const needs = needsOf(film(), lint(["seam.trim"]), "/p/p", zh);
    expect(needs[0]!.title).toBe("处接缝跳帧");
    expect(zh("starts at {s}", { s: "1·2" })).toBe("从 1·2 开始");
    expect(zh("A sentence nobody translated")).toBe("A sentence nobody translated");
    expect(translate("en")("starts at {s}", { s: "1·2" })).toBe("starts at 1·2");
    expect(translate("en")("Score||rating")).toBe("Score");
    expect(zh("Score||no such context")).toBe("总谱");
  });
});

describe("the script's text", () => {
  const v1 = "《城市漫步》\n主角：小橘。\n\n序列一 · 清晨出发（0:00–0:18，小巷）\n天刚亮。小橘伸了个懒腰。\n\n序列二 · 屋顶（0:18–0:30）\n小橘的尾巴轻轻卷在脚边，它望着远处，眼睛里映着灯光。";

  it("splits at scene headings and reads the time a heading states", () => {
    const { preamble, sections } = scriptSections(v1);
    expect(preamble).toContain("主角");
    expect(sections.map((s) => [s.fromS, s.toS])).toEqual([[0, 18], [18, 30]]);
    expect(sections[1]!.body).toContain("尾巴");
  });

  it("knows INT./EXT. headings too", () => {
    expect(scriptSections("INT. KITCHEN – NIGHT\nShe waits.\n\nEXT. STREET – DAY\nHe runs.").sections.map((s) => s.heading)).toEqual(["INT. KITCHEN – NIGHT", "EXT. STREET – DAY"]);
  });

  it("shows only the clause that was cut, not the whole sentence", () => {
    const v2 = v1.replace("小橘的尾巴轻轻卷在脚边，它望着远处，眼睛里映着灯光。", "小橘的尾巴轻轻卷在脚边。");
    const changed = diffSentences(v1, v2).filter((p) => p.kind !== "same" && p.text !== "\n");
    expect(changed).toEqual([{ kind: "removed", text: "它望着远处，眼睛里映着灯光。" }]);
  });
});

describe("the Chinese explanations of lint codes", () => {
  it("name only codes the lint really writes", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { LINT_ZH } = await import("@/studio-ui/zh/lint");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
    const src = [...files("packages/director/src"), ...files("src/studio")].map((f) => readFileSync(f, "utf8")).join("\n");
    const written = new Set([...src.matchAll(/code: "([a-z0-9_.]+)"/g)].map((m) => m[1]!));
    for (const code of Object.keys(LINT_ZH)) expect(written.has(code), `${code} is not a lint code`).toBe(true);
  });

  it("show the explanation in Chinese and the server's message beside it", async () => {
    const { lintLine } = await import("@/studio-ui/zh/lint");
    expect(lintLine("zh", { code: "seam.trim", message: "the timeline ends …" })).toEqual({ text: expect.stringContaining("接缝"), detail: "the timeline ends …" });
    expect(lintLine("en", { code: "seam.trim", message: "the timeline ends …" })).toEqual({ text: "the timeline ends …" });
    expect(lintLine("zh", { code: "no.such.code", message: "x" })).toEqual({ text: "x" });
  });
});
