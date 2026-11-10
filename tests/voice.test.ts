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

const look = LookSettings.parse({ genre: "period drama", palette: "", camera: "", lens: "", lighting: "", aspectRatio: "16:9", negative: [] });

const shotOf = (over: Partial<z.input<typeof ShotInput>> = {}, extra: Partial<Shot> = {}): Shot => ({
  id: "s", projectId: "p", sceneId: "c", index: 0, createdAt: 0, updatedAt: 0,
  spec: ShotInput.parse({
    durationS: 8, mode: "reference", intent: "She answers her brother",
    beats: [{ from: 0, to: 8, action: "Close shot: she looks up from the bedside and speaks" }],
    camera: { move: "static", amplitude: "moderate", speed: "slow" },
    characters: ["wei"], ...over,
  }),
  ...extra,
});

const asset = (id: string, url: string, kind: Asset["kind"] = "image"): Asset => ({ id, projectId: "p", url, kind, source: "upload", meta: {}, createdAt: 0 });

const voice = ElementVoice.parse({
  defaultState: "base18",
  states: [
    { id: "base18", name: "本声·18", description: "an 18-year-old young woman, mezzo voice slightly low for her age, clear and soft", refAssetIds: ["v-base"] },
    { id: "hoarse", name: "嘶哑", description: "the same young woman after a hoarseness potion: rough, breathy, rasping", refAssetIds: ["v-hoarse"] },
  ],
  source: { kind: "synthetic", detail: "Qwen3-TTS-12Hz-1.7B-VoiceDesign, seed 7" },
});

const wei: Element = { id: "wei", projectId: "p", kind: "character", name: "Wei", description: "pale oval face, plain jacket", refAssetIds: ["w"], voice, createdAt: 0, updatedAt: 0 };
const yuan: Element = { id: "yuan", projectId: "p", kind: "character", name: "Yuan", description: "thin, ill", refAssetIds: ["y"], createdAt: 0, updatedAt: 0 };
const elements = new Map([["wei", wei], ["yuan", yuan]]);
const assets = new Map([
  ["w", asset("w", "https://r2/wei.png")], ["y", asset("y", "https://r2/yuan.png")], ["h", asset("h", "https://r2/hero.png")],
  ["v-base", asset("v-base", "https://r2/wei-base.wav", "audio")], ["v-hoarse", asset("v-hoarse", "https://r2/wei-hoarse.wav", "audio")],
  ["line1", asset("line1", "https://r2/line1.wav", "audio")],
]);

const compile = (shot: Shot, extra: Partial<Parameters<typeof compileShot>[0]> = {}) =>
  compileShot({ shot, look, elements, assets, format: "lightx2v-lines", ...extra });

describe("dialogue in the H3 guide's format", () => {
  it("writes on-screen lines as (S1) says: <d>[Chinese] …</d>, Chinese by default", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "wei", text: "门关上了，路没有断。", delivery: "voice tight" }] }));
    expect(job.prompt).toContain("<Subject 1> (S1), an 18-year-old young woman, mezzo voice slightly low for her age, clear and soft, says (voice tight): <d>[Chinese] 门关上了，路没有断。</d>");
    expect(job.prompt).toContain("No extra dialogue beyond the lines above");
  });

  it("follows the project's dialogue language and a line's own language", () => {
    const en = compile(shotOf({ dialogue: [{ speaker: "wei", text: "Not tonight." }] }), { look: { ...look, dialogueLanguage: "en" } });
    expect(en.prompt).toContain("<d>[English] Not tonight.</d>");
    const ja = compile(shotOf({ dialogue: [{ speaker: "wei", text: "まだだ。", language: "ja" }] }));
    expect(ja.prompt).toContain("<d>[Japanese] まだだ。</d>");
    expect(languageTag("zh-CN")).toBe("Chinese");
    expect(languageTag(undefined)).toBe("Chinese");
  });

  it("describes the voice once, where the speaker first speaks", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "wei", text: "哥。" }, { speaker: "wei", text: "是你自己写的。" }] }));
    expect(job.prompt.match(/mezzo voice/g)?.length).toBe(1);
    expect(job.prompt).toContain("<Subject 1> (S1) says: <d>[Chinese] 是你自己写的。</d>");
  });

  it("uses the line's voice state", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "wei", text: "如何？", voiceState: "hoarse" }] }));
    expect(job.prompt).toContain("after a hoarseness potion");
    expect(voiceStateFor(wei, "missing")?.id).toBe("base18");
    expect(voiceStateFor(yuan)).toBeUndefined();
  });

  it("keeps off-screen and inner lines out of the prompt and closes every mouth", () => {
    const job = compile(shotOf({ dialogue: [
      { speaker: "yuan", text: "臣再奏，此人不是沈知远！", kind: "offscreen" },
      { speaker: "wei", text: "这一句，我等了十年。", kind: "inner" },
    ] }));
    expect(job.prompt).not.toContain("沈知远");
    expect(job.prompt).not.toContain("<d>");
    expect(job.prompt).toContain("No one in the frame speaks; every mouth stays closed");
  });

  it("puts a timed line in the [Shot k] segment of its beat and warns about a line across a cut", () => {
    const beats = [
      { from: 0, to: 4, action: "Close shot of her hands on the quilt, still" },
      { from: 4, to: 8, action: "Close shot of her face as she speaks", cut: true },
    ];
    const job = compile(shotOf({ beats, dialogue: [{ speaker: "wei", text: "哥。", startS: 5, endS: 6 }] }));
    const shot2 = job.prompt.slice(job.prompt.indexOf("[Shot 2]"));
    expect(job.prompt.indexOf("[Shot 2]")).toBeGreaterThan(0);
    expect(shot2).toContain("At 5s, <Subject 1> (S1)");
    const across = compile(shotOf({ beats, dialogue: [{ speaker: "wei", text: "哥。", startS: 3, endS: 5 }] }));
    expect(across.warnings.join(" ")).toContain("runs across a hard cut");
  });

  it("warns when the lines do not fit the shot", () => {
    const long = "沈家散了，你这个没有名分的女医，在临溪还待得住么？我拿实话求你，你要瞒多久就瞒多久。";
    const job = compile(shotOf({ durationS: 5, beats: [{ from: 0, to: 5, action: "Close shot: she speaks to the doctor" }], dialogue: [{ speaker: "wei", text: long }] }));
    expect(job.warnings.join(" ")).toMatch(/on-screen lines need about/);
    expect(lineSeconds({ speaker: "wei", text: "钱老爷断弦两年了，不嫌你年纪大，也不嫌你这双脚。", delivery: "neutral", kind: "onscreen" })).toBeCloseTo(5.3, 1);
  });
});

describe("voice references (experiments.voiceRefs)", () => {
  it("adds the speaker's state reference as <Audio 1>, bound to <Subject 1> (S1)", () => {
    const job = compile(shotOf({ dialogue: [{ speaker: "wei", text: "定银是三叔收的，自然三叔去退。", voiceState: "hoarse", startS: 1, endS: 5 }] }), { experiments: { voiceRefs: true } });
    expect(job.workflow).toBe("R2VA");
    expect(job.input.audios).toEqual([{ url: "https://r2/wei-hoarse.wav", role: "reference", label: "Wei", seconds: 5, speaker: 1 }]);
    expect(job.prompt).toContain("<Audio 1> is the voice-timbre reference for <Subject 1> (S1).");
    expect(job.prompt).toContain("<Audio 1>: reference - the target speaker (S1) follows <Audio 1>'s voice timbre without copying the original signal.");
    expect(job.prompt).toContain("[reference generation + audio reference]");
  });

  it("is off by default and skipped outside R2VA", () => {
    const off = compile(shotOf({ dialogue: [{ speaker: "wei", text: "哥。" }] }));
    expect(off.input.audios).toBeUndefined();
    expect(off.prompt).not.toContain("<Audio");
    const keyframe = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "wei", text: "哥。" }] }, { heroAssetId: "h" }), { experiments: { voiceRefs: true } });
    expect(keyframe.workflow).toBe("I2VA");
    expect(keyframe.input.audios).toBeUndefined();
    expect(keyframe.warnings.join(" ")).toContain("voice references need R2VA");
  });

  it("says when a speaker has no reference audio", () => {
    const job = compile(shotOf({ characters: ["yuan"], dialogue: [{ speaker: "yuan", text: "三叔又来了？" }] }), { experiments: { voiceRefs: true } });
    expect(job.input.audios).toBeUndefined();
    expect(job.warnings.join(" ")).toContain("Yuan has no reference audio");
  });

  it("changes the render hash only when audio is present", () => {
    const images = [{ url: "https://r2/wei.png", role: "reference" }];
    expect(renderHash("R2VA", "p", images)).toBe(renderHash("R2VA", "p", images, []));
    expect(renderHash("R2VA", "p", images, audioInputs({ audios: [{ url: "https://r2/a.wav", seconds: 4 }] }))).not.toBe(renderHash("R2VA", "p", images));
  });
});

describe("audio first (experiments.audioFirst)", () => {
  it("anchors the prepared line at its start frame in I2VA", () => {
    const job = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "wei", text: "门关上了，路没有断。", startS: 1.5, endS: 4.5, audioAssetId: "line1" }] }, { heroAssetId: "h" }), { experiments: { audioFirst: true } });
    expect(job.workflow).toBe("I2VA");
    expect(job.input.guide_audio).toEqual({ url: "https://r2/line1.wav", frame: 36 });
  });

  it("needs prepared audio and I2VA", () => {
    const none = compile(shotOf({ mode: "keyframe", dialogue: [{ speaker: "wei", text: "哥。" }] }, { heroAssetId: "h" }), { experiments: { audioFirst: true } });
    expect(none.input.guide_audio).toBeUndefined();
    expect(none.warnings.join(" ")).toContain("no on-screen line has prepared audio");
    const r2va = compile(shotOf({ dialogue: [{ speaker: "wei", text: "哥。", audioAssetId: "line1" }] }), { experiments: { audioFirst: true } });
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
    const base = await repo.createAsset({ projectId: null, url: "https://r2/lib/wei-base.wav", kind: "audio", source: "upload" });
    const older = await repo.createAsset({ projectId: null, url: "https://r2/lib/wei-28.wav", kind: "audio", source: "upload" });
    const card = await repo.createVoiceCard(null, {
      name: "Wei", status: "draft", defaultState: "base18",
      states: [
        { id: "base18", name: "本声·18", description: "an 18-year-old young woman, clear and soft", refAssetIds: [base.id] },
        { id: "base28", name: "本声·28", description: "the same woman at 28, lower and steadier", refAssetIds: [older.id] },
      ],
      source: { kind: "synthetic", detail: "voice design, seed 7" },
    });
    expect(card.projectId).toBeNull();

    const p1 = await repo.createProject({ name: "prologue", look: { aspectRatio: "16:9" } });
    const p2 = await repo.createProject({ name: "chapter one", look: { aspectRatio: "16:9" } });
    const young = await repo.createElement(p1.id, { kind: "character", name: "Wei", description: "18", voiceCardId: card.id });
    const grown = await repo.createElement(p2.id, { kind: "character", name: "Wei", description: "28", voiceCardId: card.id, voiceState: "base28" });
    expect(young.voice?.defaultState).toBe("base18");
    expect(grown.voice?.defaultState).toBe("base28");

    await repo.updateVoiceCard(card.id, { states: [
      { id: "base18", name: "本声·18", description: "an 18-year-old young woman, mezzo, clear and soft", refAssetIds: [base.id] },
      { id: "base28", name: "本声·28", description: "the same woman at 28, lower and steadier", refAssetIds: [older.id] },
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
    expect(copied.voice?.defaultState).toBe("base28");

    /* compile through the orchestrator: the card's audio reaches R2VA */
    const ref = await repo.createAsset({ projectId: p2.id, url: "https://r2/p2/wei-front.png", kind: "image", source: "upload" });
    await repo.updateElement(grown.id, { refAssetIds: [ref.id] });
    const scene = await repo.createScene(p2.id, { slug: "hall" });
    const shot = await repo.createShot(p2.id, scene.id, ShotInput.parse({
      durationS: 6, mode: "reference", intent: "She answers the emperor",
      beats: [{ from: 0, to: 6, action: "Close shot: she raises her eyes and speaks" }],
      camera: { move: "static", amplitude: "moderate", speed: "slow" },
      characters: [grown.id], dialogue: [{ speaker: grown.id, text: "臣，有一问。", startS: 1, endS: 3 }],
    }));
    const job = await orch.compileForShot(shot.id, { experiments: { voiceRefs: true } });
    expect(job.input.audios?.[0]?.url).toBe("https://r2/lib/wei-28.wav");
    expect(job.prompt).toContain("the same woman at 28, lower and steadier");
    expect(job.prompt).toContain("<d>[Chinese] 臣，有一问。</d>");
  });

  it("refuses a default state the card does not have and an unknown card", async () => {
    await expect(repo.createVoiceCard(null, { name: "X", status: "draft", defaultState: "nope", states: [{ id: "a", name: "A", description: "a voice", refAssetIds: [] }] })).rejects.toThrow(/defaultState/);
    const p = await repo.createProject({ name: "p3" });
    await expect(repo.createElement(p.id, { kind: "character", name: "Y", description: "", voiceCardId: "vc_missing" })).rejects.toThrow();
  });
});
