import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as repo from "@/studio/repo";
import { ShotInput } from "@/studio/schemas";
import type { Actor } from "@/studio/types";
import * as voiceApi from "@/studio/voice-api";
import * as voicePod from "@/studio/voice-pod";
import { signHookUrl } from "@/studio/backends/runpod";
import { POST as voiceHook } from "@/app/api/voice/hook/route";

/* Qwen3-TTS VoiceDesign on the GPU pod: a line spoken several times, checked, one take kept.
   The pod, R2 and TokenSail's ASR are faked at fetch. */

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

const POD = "https://pod1-8000.proxy.runpod.net";
type Call = { url: string; method: string; body?: unknown; token?: string | null };
let calls: Call[] = [];
let podVoice: Record<string, unknown> = { ready: true };
let heard: string[] = [];
let podStatus: Record<string, unknown> = { id: "pj1", status: "IN_PROGRESS" };
const user: Actor = { user: "tester", via: "web" };

beforeAll(async () => {
  setDb(await memoryDb());
  Object.assign(process.env, {
    R2_ACCOUNT_ID: "acct", R2_BUCKET: "studio", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_PUBLIC_BASE_URL: "https://studio.example/media",
    RUNPOD_MODE: "pod", RUNPOD_API_KEY: "k", RUNPOD_WEBHOOK_SECRET: "s3cret", STUDIO_WORKER_TOKEN: "tok", STUDIO_PUBLIC_URL: "https://studio.example",
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const headers = new Headers(init?.headers ?? req?.headers);
    calls.push({ url, method, body: init?.body, token: headers.get("x-studio-token") });
    if (url === `${POD}/health`) return Response.json({ ok: true, comfy: { reachable: true }, downloads: { active: false }, voice: podVoice });
    if (url === `${POD}/voice` && method === "POST") return Response.json({ id: "pj1", status: "IN_QUEUE" });
    if (url === `${POD}/status/pj1`) return Response.json(podStatus);
    if (url.includes("r2.cloudflarestorage.com")) return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: heard.shift() ?? "" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  calls = [];
  podVoice = { ready: true };
  heard = [];
  podStatus = { id: "pj1", status: "IN_PROGRESS" };
  process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
});

let podMade = false;
async function setup(opts: { delivery?: string } = {}) {
  if (!podMade) {
    await repo.insertGpuPod({ id: "pod1", name: "p", image: "img", status: "running", hostUrl: POD, costPerHr: 1 });
    podMade = true;
  }
  const project = await repo.createProject({ name: "voices" });
  const sample = await repo.createAsset({ projectId: null, url: "https://studio.example/media/u/mara.wav", kind: "audio", source: "upload", meta: { key: "u/mara.wav" } });
  const card = await repo.createVoiceCard(null, {
    name: "Mara", status: "draft", defaultState: "young",
    states: [{ id: "young", name: "Young", description: "a young woman in her twenties, mezzo voice, clear and soft.", refAssetIds: [sample.id] }],
  });
  const mara = await repo.createElement(project.id, { kind: "character", name: "Mara", description: "young", voiceCardId: card.id });
  const scene = await repo.createScene(project.id, { slug: "hall" });
  const shot = await repo.createShot(project.id, scene.id, ShotInput.parse({
    durationS: 6, mode: "text", intent: "She answers from the doorway",
    beats: [{ from: 0, to: 6, action: "Wide shot: she stands in the doorway and answers" }],
    camera: { move: "static" }, characters: [mara.id],
    dialogue: [{ speaker: mara.id, text: "今晚的雨下得真大。", kind: "offscreen", delivery: opts.delivery ?? "furious, voice raised" }],
  }));
  await voiceApi.setVoicing(project.id, { enabled: true, model: voicePod.POD_VOICE_MODEL, maxChars: 1000 }, user);
  return { project, sample, card, shot };
}

const done = (takes: Array<{ seed: number; similarity: number | null }>) => ({
  id: "pj1", status: "COMPLETED", executionTime: 9000,
  output: { model: "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", takes: takes.map((t, i) => ({ ...t, url: `https://media/x/take-${i + 1}.wav`, key: `projects/p/voice/vjb/take-${i + 1}-s${t.seed}.wav`, duration_s: 2.6 })) },
});

describe("the voice description", () => {
  it("is the card state's description with the line's delivery after it, neutral adding nothing", () => {
    expect(voicePod.buildInstruct("a young woman, mezzo voice.", "furious")).toBe("a young woman, mezzo voice. Emotion and delivery: furious");
    expect(voicePod.buildInstruct("a young woman。", "neutral")).toBe("a young woman");
    expect(() => voicePod.buildInstruct("  ", "angry")).toThrow(/voice description/);
    expect(voicePod.podLanguage("zh")).toBe("Chinese");
    expect(voicePod.podLanguage("en-GB")).toBe("English");
    expect(() => voicePod.podLanguage("th")).toThrow(/speaks/);
  });
});

describe("speaking a line on the GPU pod", () => {
  it("sends the line, the voice with its emotion, one seed per take and the card's reference to the pod", async () => {
    const { project, card, shot, sample } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { takes: 3 }, user);
    expect(job.status).toBe("running");
    expect(job.backendJobId).toBe("pj1");
    const sent = calls.find((c) => c.url === `${POD}/voice`)!;
    expect(sent.token).toBe("tok");
    const body = JSON.parse(String(sent.body)) as { input: Record<string, unknown>; webhook: string };
    expect(body.input).toMatchObject({
      text: "今晚的雨下得真大。", language: "Chinese", anchor_url: sample.url,
      instruct: "a young woman in her twenties, mezzo voice, clear and soft. Emotion and delivery: furious, voice raised",
      output: { prefix: `projects/${project.id}/voice/${job.id}` }, studio_voice_job_id: job.id,
    });
    expect((body.input.seeds as number[]).length).toBe(3);
    expect(new Set(body.input.seeds as number[]).size).toBe(3);
    expect(body.webhook).toMatch(new RegExp(`^https://studio\\.example/api/voice/hook\\?id=${job.id}&ts=\\d+&sig=`));
    expect(job).toMatchObject({ voiceCardId: card.id, stateId: "young", shotId: shot.id, lineIndex: 0, delivery: "furious, voice raised", model: "qwen3-tts-voicedesign" });
    /* each take counts against the character budget */
    expect((await voiceApi.voicingStatus(project.id)).usedChars).toBe(9 * 3);
  });

  it("says plainly when the pod cannot speak, and spends nothing", async () => {
    const { project, shot } = await setup();
    podVoice = { ready: false, why: "the voice environment is installing" };
    await expect(voicePod.speakLine(project.id, shot.id, 0, {}, user)).rejects.toThrow(/cannot speak yet: the voice environment is installing/);
    expect(calls.some((c) => c.url === `${POD}/voice`)).toBe(false);
    expect((await voiceApi.voicingStatus(project.id)).usedChars).toBe(0);
  });

  it("brings the takes back with their checks: far from the voice, or misheard", async () => {
    const { project, shot } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { seeds: [11, 12, 13] }, user);
    heard = ["今晚的雨下得真大", "今晚的雨下得真大", "今晚的鱼不大"];
    podStatus = done([{ seed: 11, similarity: 0.71 }, { seed: 12, similarity: 0.42 }, { seed: 13, similarity: 0.66 }]);
    const back = await voicePod.getVoiceJob(project.id, job.id);
    expect(back.status).toBe("done");
    expect(back.executionMs).toBe(9000);
    expect(back.takes.map((t) => [t.index, t.seed, t.flags])).toEqual([[1, 11, []], [2, 12, ["off_voice"]], [3, 13, ["misread"]]]);
    expect(back.takes[0]!.url).toBe("https://studio.example/media/projects/p/voice/vjb/take-1-s11.wav");
    expect(back.takes[2]).toMatchObject({ heard: "今晚的鱼不大" });
  });

  it("keeps the take the user picks: an asset with its seed and description, the card's reference, the line's audio", async () => {
    const { project, shot, card } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { seeds: [21, 22] }, user);
    heard = ["今晚的雨下得真大", "今晚的雨下得真大"];
    podStatus = done([{ seed: 21, similarity: 0.6 }, { seed: 22, similarity: 0.7 }]);
    await voicePod.getVoiceJob(project.id, job.id);
    const { asset, attachedTo, job: picked } = await voicePod.pickVoiceTake(project.id, job.id, { take: 2, addAsReference: true, attachToLine: true }, user);
    expect(asset).toMatchObject({ kind: "audio", projectId: project.id });
    expect(asset.meta).toMatchObject({ provider: "pod", model: "qwen3-tts-voicedesign", seed: 22, text: "今晚的雨下得真大。", voiceJobId: job.id, instruct: expect.stringContaining("Emotion and delivery: furious") });
    expect(picked).toMatchObject({ picked: 2, pickedAssetId: asset.id });
    expect(attachedTo).toEqual({ shotId: shot.id, lineIndex: 0 });
    expect((await repo.getShot(shot.id)).spec.dialogue[0]!.audioAssetId).toBe(asset.id);
    expect((await repo.getVoiceCard(card.id)).states[0]!.refAssetIds).toContain(asset.id);
    /* picking it again keeps the same asset */
    expect((await voicePod.pickVoiceTake(project.id, job.id, { take: 2 }, user)).asset.id).toBe(asset.id);
  });

  it("takes the pod's signed call back, and refuses an unsigned one", async () => {
    const { project, shot } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { seeds: [51, 52] }, user);
    heard = ["今晚的雨下得真大", "今晚的雨下得真大"];
    const url = await signHookUrl("https://studio.example", "/api/voice/hook", "s3cret", job.id);
    const res = await voiceHook(new Request(url, { method: "POST", body: JSON.stringify(done([{ seed: 51, similarity: 0.7 }, { seed: 52, similarity: null }])) }));
    expect(await res.json()).toEqual({ ok: true, status: "done" });
    expect((await repo.getVoiceJob(job.id)).takes.map((t) => t.similarity)).toEqual([0.7, null]);
    const forged = await voiceHook(new Request(`https://studio.example/api/voice/hook?id=${job.id}&ts=${Date.now()}&sig=00`, { method: "POST", body: "{}" }));
    expect(forged.status).toBe(401);
  });

  it("will not put a take on a line whose words changed since", async () => {
    const { project, shot } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { seeds: [31] }, user);
    podStatus = done([{ seed: 31, similarity: 0.6 }]);
    await voicePod.getVoiceJob(project.id, job.id);
    const s = await repo.getShot(shot.id);
    await repo.updateShot(shot.id, { spec: { ...s.spec, dialogue: [{ ...s.spec.dialogue[0]!, text: "雨停了。" }] } });
    await expect(voicePod.pickVoiceTake(project.id, job.id, { take: 1, attachToLine: true }, user)).rejects.toThrow(/has changed/);
  });

  it("a failed job says why; TokenSail models refuse the pod path and the pod model refuses a stored voice", async () => {
    const { project, shot, card } = await setup();
    const job = await voicePod.speakLine(project.id, shot.id, 0, { seeds: [41] }, user);
    podStatus = { id: "pj1", status: "FAILED", error: "voice design failed on take 1: CUDA out of memory" };
    expect(await voicePod.getVoiceJob(project.id, job.id)).toMatchObject({ status: "failed", error: expect.stringContaining("out of memory") });
    await expect(voiceApi.createApiVoice(project.id, { voiceCardId: card.id, mode: "design" })).rejects.toThrow(/keeps no voice/);
    await expect(voiceApi.speak(project.id, { text: "你好" }, user)).rejects.toThrow(/runs on the GPU pod/);
    expect((await voiceApi.projectVoiceModel(project.id))?.provider).toBe("pod");
  });

  it("a line with no voice card, or a voice off, is refused before the pod is asked", async () => {
    const { project, shot } = await setup();
    const plain = await repo.createElement(project.id, { kind: "character", name: "Theo", description: "" });
    const s = await repo.getShot(shot.id);
    await repo.updateShot(shot.id, { spec: { ...s.spec, dialogue: [{ ...s.spec.dialogue[0]!, speaker: plain.id }] } });
    await expect(voicePod.speakLine(project.id, shot.id, 0, {}, user)).rejects.toThrow(/has no voice card/);
    await voiceApi.setVoicing(project.id, { enabled: false }, user);
    await expect(voicePod.speakTakes(project.id, { text: "你好", description: "a calm voice" }, user)).rejects.toThrow(/voice generation is off/);
    expect(calls.some((c) => c.url === `${POD}/voice`)).toBe(false);
  });
});
