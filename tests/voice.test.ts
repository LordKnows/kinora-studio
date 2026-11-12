import { beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { compileShot, languageTag, lineSeconds, voiceStateFor } from "@/studio/compiler";
import { audioInputs, renderHash } from "@/studio/craft-core";
import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as orch from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ElementVoice, LookSettings, ShotInput } from "@/studio/schemas";
import type { Asset, Element, Shot } from "@/studio/types";

/* Dialogue in the H3 guide's format, voice cards, R2VA voice references and
   the audio-first anchor. */

const look = LookSettings.parse({ genre: "drama", palette: "", camera: "", lens: "", lighting: "", aspectRatio: "16:9", negative: [] });

const shotOf = (over: Partial<z.input<typeof ShotInput>> = {}, extra: Partial<Shot> = {}): Shot => ({
  id: "s", projectId: "p", sceneId: "c", index: 0, createdAt: 0, updatedAt: 0,
  spec: ShotInput.parse({
    durationS: 8, mode: "reference", intent: "She answers her friend",
    beats: [{ from: 0, to: 8, action: "Close shot: she looks up from the table and speaks" }],
    camera: { move: "static", amplitude: "moderate", speed: "slow" },
    characters: ["mara"], ...over,
  }),
  ...extra,
});

const asset = (id: string, url: string, kind: Asset["kind"] = "image"): Asset => ({ id, projectId: "p", url, kind, source: "upload", meta: {}, createdAt: 0 });

const voice = ElementVoice.parse({
  defaultState: "young",
  states: [
    { id: "young", name: "Young", description: "a young woman in her twenties, mezzo voice, clear and soft", refAssetIds: ["v-base"] },
    { id: "hoarse", name: "Hoarse", description: "the same young woman with a heavy cold: rough, breathy, rasping", refAssetIds: ["v-hoarse"] },
  ],
  source: { kind: "synthetic", detail: "a voice design model, seed 7" },
});

const mara: Element = { id: "mara", projectId: "p", kind: "character", name: "Mara", description: "short dark hair, grey coat", refAssetIds: ["w"], voice, createdAt: 0, updatedAt: 0 };
const theo: Element = { id: "theo", projectId: "p", kind: "character", name: "Theo", description: "tall, tired", refAssetIds: ["y"], createdAt: 0, updatedAt: 0 };
const elements = new Map([["mara", mara], ["theo", theo]]);
const assets = new Map([
  ["w", asset("w", "https://r2/mara.png")], ["y", asset("y", "https://r2/theo.png")], ["h", asset("h", "https://r2/hero.png")],
  ["v-base", asset("v-base", "https://r2/mara-base.wav", "audio")], ["v-hoarse", asset("v-hoarse", "https://r2/mara-hoarse.wav", "audio")],
  ["line1", asset("line1", "https://r2/line1.wav", "audio")],
]);

const compile = (shot: Shot, extra: Partial<Parameters<typeof compileShot>[0]> = {}) =>
  compileShot({ shot, look, elements, assets, format: "lightx2v-lines", ...extra });

describe("dialogue in the H3 guide's format", () => {
  it("writes on-screen lines as (S1) says: <d>[Chinese] …</d>, Chinese by default", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "mara", text: "今晚的雨下得真大。", delivery: "voice tight" }] }));
    expect(job.prompt).toContain("<Subject 1> (S1), a young woman in her twenties, mezzo voice, clear and soft, says (voice tight): <d>[Chinese] 今晚的雨下得真大。</d>");
    expect(job.prompt).toContain("The lines above are the only words spoken.");
  });

  it("follows the project's dialogue language and a line's own language", () => {
    const en = compile(shotOf({ dialogue: [{ speaker: "mara", text: "Not tonight." }] }), { look: { ...look, dialogueLanguage: "en" } });
    expect(en.prompt).toContain("<d>[English] Not tonight.</d>");
    const ja = compile(shotOf({ dialogue: [{ speaker: "mara", text: "まだだ。", language: "ja" }] }));
    expect(ja.prompt).toContain("<d>[Japanese] まだだ。</d>");
    expect(languageTag("zh-CN")).toBe("Chinese");
    expect(languageTag(undefined)).toBe("Chinese");
  });

  it("describes the voice once, where the speaker first speaks", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "mara", text: "走吧。" }, { speaker: "mara", text: "你先回去吧。" }] }));
    expect(job.prompt.match(/mezzo voice/g)?.length).toBe(1);
    expect(job.prompt).toContain("<Subject 1> (S1) says: <d>[Chinese] 你先回去吧。</d>");
  });

  it("uses the line's voice state", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "mara", text: "我没事。", voiceState: "hoarse" }] }));
    expect(job.prompt).toContain("with a heavy cold");
    expect(voiceStateFor(mara, "missing")?.id).toBe("young");
    expect(voiceStateFor(theo)).toBeUndefined();
  });

  it("keeps off-screen and inner lines out of the prompt and closes every mouth", () => {
    const job = compile(shotOf({ dialogue: [
      { speaker: "theo", text: "大人，门外有人求见！", kind: "offscreen" },
      { speaker: "mara", text: "我早就知道会是这样。", kind: "inner" },
    ] }));
    expect(job.prompt).not.toContain("门外有人");
    expect(job.prompt).not.toContain("<d>");
    expect(job.prompt).toContain("<Subject 1> stays silent, lips closed.");
  });

  it("says who is silent by name, as what happens, and only when someone is in the shot", () => {
    /* no lines: the cast is silent */
    expect(compile(shotOf({})).prompt).toContain("<Subject 1> stays silent.");
    expect(compile(shotOf({ characters: ["mara", "theo"] })).prompt).toMatch(/<Subject 1> and (<Subject 2>|Theo) stay silent\./);
    expect(compile(shotOf({ mode: "keyframe" }, { heroAssetId: "h" })).prompt).toContain("Mara stays silent.");
    /* a voice that is not speech (a laugh in the action, a purr in the sound) is not silenced */
    expect(compile(shotOf({ beats: [{ from: 0, to: 8, action: "Mara laughs and shakes her head" }] })).prompt).not.toContain("silent");
    expect(compile(shotOf({ sound: { sfx: ["a soft cat purr"], ambience: "", music: "N/A" } })).prompt).not.toContain("silent");
    /* nobody in the shot: nothing is said about speech, so no people are asked for */
    const empty = compile(shotOf({ mode: "text", characters: [] })).prompt;
    expect(empty).not.toContain("silent");
    expect(empty).not.toMatch(/\bNo (dialogue|one)\b/);
    /* off-screen lines over a shot with nobody listed still close the mouths in frame */
    expect(compile(shotOf({ mode: "text", characters: [], dialogue: [{ speaker: "theo", text: "门外有人。", kind: "offscreen" }] })).prompt).toContain("Everyone in the frame stays silent, lips closed.");
    /* the rule itself carries no negation */
    for (const p of [compile(shotOf({})).prompt, compile(shotOf({ dialogue: [{ speaker: "mara", text: "好。" }] })).prompt]) {
      expect(p).not.toMatch(/\b(No dialogue|No extra dialogue|No one|No subtitles)\b/);
    }
  });

  it("puts a timed line in the [Shot k] segment of its beat and warns about a line across a cut", () => {
    const beats = [
      { from: 0, to: 4, action: "Close shot of her hands on the quilt, still" },
      { from: 4, to: 8, action: "Close shot of her face as she speaks", cut: true },
    ];
    const job = compile(shotOf({ beats, dialogue: [{ speaker: "mara", text: "走吧。", startS: 5, endS: 6 }] }));
    const shot2 = job.prompt.slice(job.prompt.indexOf("[Shot 2]"));
    expect(job.prompt.indexOf("[Shot 2]")).toBeGreaterThan(0);
    expect(shot2).toContain("At 5s, <Subject 1> (S1)");
    const across = compile(shotOf({ beats, dialogue: [{ speaker: "mara", text: "走吧。", startS: 3, endS: 5 }] }));
    expect(across.warnings.join(" ")).toContain("runs across a hard cut");
  });

  it("warns when the lines do not fit the shot", () => {
    const long = "这件事你最好现在就告诉我，不然等到明天早上，所有人都会知道，到时候谁也帮不了你。";
    const job = compile(shotOf({ durationS: 5, beats: [{ from: 0, to: 5, action: "Close shot: she speaks to the doctor" }], dialogue: [{ speaker: "mara", text: long }] }));
    expect(job.warnings.join(" ")).toMatch(/on-screen lines need about/);
    expect(lineSeconds({ speaker: "mara", text: "今天早上我去了一趟城东，买回来两斤新茶叶。", delivery: "neutral", kind: "onscreen" })).toBeCloseTo(4.8, 1);
  });
});

describe("voice references (experiments.voiceRefs)", () => {
  it("adds the speaker's state reference as <Audio 1>, bound to <Subject 1> (S1)", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "mara", text: "这几天嗓子坏了，大家见谅。", voiceState: "hoarse", startS: 1, endS: 5 }] }), { experiments: { voiceRefs: true } });
    expect(job.workflow).toBe("R2VA");
    expect(job.input.audios).toEqual([{ url: "https://r2/mara-hoarse.wav", role: "reference", label: "Mara", seconds: 5, speaker: 1 }]);
    expect(job.prompt).toContain("<Audio 1> is the voice-timbre reference for <Subject 1> (S1).");
    expect(job.prompt).toContain("<Audio 1>: reference - the target speaker (S1) follows <Audio 1>'s voice timbre without copying the original signal.");
    expect(job.prompt).toContain("[reference generation + audio reference]");
  });

  it("is off by default and skipped outside R2VA", () => {
    const off = compile(shotOf({ dialogue: [{ speaker: "mara", text: "走吧。" }] }));
    expect(off.input.audios).toBeUndefined();
    expect(off.prompt).not.toContain("<Audio");
    const keyframe = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "mara", text: "走吧。" }] }, { heroAssetId: "h" }), { experiments: { voiceRefs: true } });
    expect(keyframe.workflow).toBe("I2VA");
    expect(keyframe.input.audios).toBeUndefined();
    expect(keyframe.warnings.join(" ")).toContain("voice references need R2VA");
  });

  it("says when a speaker has no reference audio", () => {
    const job = compile(shotOf({ characters: ["theo"], dialogue: [{ speaker: "theo", text: "你又来了？" }] }), { experiments: { voiceRefs: true } });
    expect(job.input.audios).toBeUndefined();
    expect(job.warnings.join(" ")).toContain("Theo has no reference audio");
  });

  it("changes the render hash only when audio is present", () => {
    const images = [{ url: "https://r2/mara.png", role: "reference" }];
    expect(renderHash("R2VA", "p", images)).toBe(renderHash("R2VA", "p", images, []));
    expect(renderHash("R2VA", "p", images, audioInputs({ audios: [{ url: "https://r2/a.wav", seconds: 4 }] }))).not.toBe(renderHash("R2VA", "p", images));
  });
});

describe("audio first (experiments.audioFirst)", () => {
  it("anchors the prepared line at its start frame in I2VA", () => {
    const job = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "mara", text: "今晚的雨下得真大。", startS: 1.5, endS: 4.5, audioAssetId: "line1" }] }, { heroAssetId: "h" }), { experiments: { audioFirst: true } });
    expect(job.workflow).toBe("I2VA");
    expect(job.input.guide_audio).toEqual({ url: "https://r2/line1.wav", frame: 36 });
  });

  it("needs prepared audio and I2VA", () => {
    const none = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "mara", text: "走吧。" }] }, { heroAssetId: "h" }), { experiments: { audioFirst: true } });
    expect(none.input.guide_audio).toBeUndefined();
    expect(none.warnings.join(" ")).toContain("no on-screen line has prepared audio");
    const r2va = compile(shotOf({ dialogue: [{ speaker: "mara", text: "走吧。", audioAssetId: "line1" }] }), { experiments: { audioFirst: true } });
    expect(r2va.input.guide_audio).toBeUndefined();
    expect(r2va.warnings.join(" ")).toContain("audioFirst needs I2VA");
  });
});

/* ---------- the global voice-card library ---------- */

async function memoryDb(): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db: Db = {
    async all<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).all(...(params as never[])) as T[]; },
    async get<T>(sql: string, params: unknown[] = []) { return sqlite.prepare(sql).get(...(params as never[])) as T | undefined; },
    async run(sql: string, params: unknown[] = []) { return { changes: Number(sqlite.prepare(sql).run(...(params as never[])).changes) }; },
    async exec(sql: string) { sqlite.exec(sql); },
  };
  await migrate(db);
  return db;
}

describe("voice cards are a global library", () => {
  beforeAll(async () => {
    setDb(await memoryDb());
    process.env.RUNPOD_MODE = "serverless";
  });

  it("serves one card to elements in several projects, each with its own default state", async () => {
    const base = await repo.createAsset({ projectId: null, url: "https://r2/lib/mara-base.wav", kind: "audio", source: "upload" });
    const older = await repo.createAsset({ projectId: null, url: "https://r2/lib/mara-older.wav", kind: "audio", source: "upload" });
    const card = await repo.createVoiceCard(null, {
      name: "Mara", status: "draft", defaultState: "young",
      states: [
        { id: "young", name: "Young", description: "a young woman, clear and soft", refAssetIds: [base.id] },
        { id: "older", name: "Older", description: "the same woman ten years older, lower and steadier", refAssetIds: [older.id] },
      ],
      source: { kind: "synthetic", detail: "voice design, seed 7" },
    });
    expect(card.projectId).toBeNull();

    const p1 = await repo.createProject({ name: "prologue", look: { aspectRatio: "16:9" } });
    const p2 = await repo.createProject({ name: "chapter one", look: { aspectRatio: "16:9" } });
    const young = await repo.createElement(p1.id, { kind: "character", name: "Mara", description: "young", voiceCardId: card.id });
    const grown = await repo.createElement(p2.id, { kind: "character", name: "Mara", description: "older", voiceCardId: card.id, voiceState: "older" });
    expect(young.voice?.defaultState).toBe("young");
    expect(grown.voice?.defaultState).toBe("older");

    await repo.updateVoiceCard(card.id, { states: [
      { id: "young", name: "Young", description: "a young woman, mezzo, clear and soft", refAssetIds: [base.id] },
      { id: "older", name: "Older", description: "the same woman ten years older, lower and steadier", refAssetIds: [older.id] },
    ] });
    const both = await repo.getElements([young.id, grown.id]);
    expect(both.get(young.id)?.voice?.states[0]?.description).toContain("mezzo");
    expect(both.get(grown.id)?.voice?.states[0]?.description).toContain("mezzo");

    expect((await repo.listVoiceCards(null)).map((c) => c.id)).toEqual([card.id]);
    expect((await repo.listVoiceCards(p1.id)).map((c) => c.id)).toEqual([card.id]);
    expect((await repo.listVoiceCards(p1.id, false))).toEqual([]);
    expect((await repo.elementsUsingVoiceCard(card.id)).map((e) => e.id).sort()).toEqual([young.id, grown.id].sort());

    /* the copy into another project keeps pointing at the same card */
    const copied = await repo.copyElement(grown.id, p1.id);
    expect(copied.voiceCardId).toBe(card.id);
    expect(copied.voice?.defaultState).toBe("older");

    /* compile through the orchestrator: the card's audio reaches R2VA */
    const ref = await repo.createAsset({ projectId: p2.id, url: "https://r2/p2/mara-front.png", kind: "image", source: "upload" });
    await repo.updateElement(grown.id, { refAssetIds: [ref.id] });
    const scene = await repo.createScene(p2.id, { slug: "hall" });
    const shot = await repo.createShot(p2.id, scene.id, ShotInput.parse({
      durationS: 6, mode: "reference", intent: "She answers the judge",
      beats: [{ from: 0, to: 6, action: "Close shot: she raises her eyes and speaks" }],
      camera: { move: "static", amplitude: "moderate", speed: "slow" },
      characters: [grown.id], dialogue: [{ speaker: grown.id, text: "我有一个问题。", startS: 1, endS: 3 }],
    }));
    const job = await orch.compileForShot(shot.id, { experiments: { voiceRefs: true } });
    expect(job.input.audios?.[0]?.url).toBe("https://r2/lib/mara-older.wav");
    expect(job.prompt).toContain("the same woman ten years older, lower and steadier");
    expect(job.prompt).toContain("<d>[Chinese] 我有一个问题。</d>");
  });

  it("refuses a default state the card does not have and an unknown card", async () => {
    await expect(repo.createVoiceCard(null, { name: "X", status: "draft", defaultState: "nope", states: [{ id: "a", name: "A", description: "a voice", refAssetIds: [] }] })).rejects.toThrow(/defaultState/);
    const p = await repo.createProject({ name: "p3" });
    await expect(repo.createElement(p.id, { kind: "character", name: "Y", description: "", voiceCardId: "vc_missing" })).rejects.toThrow();
  });
});
