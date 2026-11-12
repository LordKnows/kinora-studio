import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "@/db";
import { migrate } from "@/db/migrate";
import * as repo from "@/studio/repo";
import type { Actor } from "@/studio/types";
import * as voiceApi from "@/studio/voice-api";

/* The voice API (TokenSail audio endpoints) behind the project switch, with the
   provider and R2 faked at fetch. */

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

type Call = { url: string; method: string; body?: unknown; auth?: string | null };
let calls: Call[] = [];
const user: Actor = { user: "tester", via: "web" };
const SAMPLE = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

beforeAll(async () => {
  setDb(await memoryDb());
  process.env.R2_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "studio";
  process.env.R2_ACCESS_KEY_ID = "a";
  process.env.R2_SECRET_ACCESS_KEY = "b";
  process.env.R2_PUBLIC_BASE_URL = "https://studio.example/media";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : undefined;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const headers = new Headers(init?.headers ?? req?.headers);
    calls.push({ url, method, body: init?.body, auth: headers.get("authorization") });
    if (url.includes("r2.cloudflarestorage.com")) return method === "GET" ? new Response(SAMPLE, { headers: { "content-type": "audio/wav" } }) : new Response(null, { status: 200 });
    if (url.endsWith("/audio/voices") && method === "POST") return Response.json({ id: `tv_${"a".repeat(24)}`, status: "active" }, { status: 201 });
    if (url.endsWith("/audio/voices") && method === "GET") return Response.json({ data: [{ id: `tv_${"a".repeat(24)}` }] });
    if (url.includes("/audio/voices/") && method === "DELETE") return Response.json({ id: "x", deleted: true });
    if (url.endsWith("/audio/speech")) return new Response(new Uint8Array([1, 2, 3, 4, 5]), { headers: { "content-type": "audio/wav", "x-tokensail-request-id": "req_1" } });
    if (url.endsWith("/audio/transcriptions")) return Response.json({ text: "今晚的雨下得真大" });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

beforeEach(() => {
  calls = [];
  process.env.TOKENSAIL_API_KEY = "sk-tokensail-test";
});

async function setup() {
  const project = await repo.createProject({ name: "voices" });
  const sample = await repo.createAsset({ projectId: null, url: "https://studio.example/media/u/mara.wav", kind: "audio", source: "upload", meta: { key: "u/mara.wav" } });
  const card = await repo.createVoiceCard(null, {
    name: "Mara", status: "draft", defaultState: "young",
    states: [{ id: "young", name: "Young", description: "a young woman in her twenties, mezzo voice, clear and soft", refAssetIds: [sample.id] }],
  });
  return { project, sample, card };
}

describe("the voice API switch", () => {
  it("is off by default and refuses until the user switches it on", async () => {
    const { project, card } = await setup();
    const status = await voiceApi.voicingStatus(project.id);
    expect(status.enabled).toBe(false);
    expect(status.model).toBe("qwen-audio-3.0-tts-plus");
    expect(status.keyReady).toBe(true);
    await expect(voiceApi.speak(project.id, { text: "你好", voiceCardId: card.id }, user)).rejects.toThrow(/Settings page/);
    expect(calls).toEqual([]);
  });

  it("names the missing Worker secret", async () => {
    const { project } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true }, user);
    delete process.env.TOKENSAIL_API_KEY;
    expect((await voiceApi.voicingStatus(project.id)).note).toMatch(/TOKENSAIL_API_KEY/);
    await expect(voiceApi.speak(project.id, { text: "你好" }, user)).rejects.toThrow(/TOKENSAIL_API_KEY/);
  });
});

describe("making and using a voice", () => {
  it("clones a card state's reference audio, keeps the voice on the state, then speaks with it", async () => {
    const { project, card } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true, maxChars: 1000 }, user);
    const { voice, voiceCard } = await voiceApi.createApiVoice(project.id, { voiceCardId: card.id, mode: "clone" });
    const create = calls.find((c) => c.url === "https://api.tokensail.ai/v1/audio/voices")!;
    expect(create.auth).toBe("Bearer sk-tokensail-test");
    const form = create.body as FormData;
    expect(form.get("mode")).toBe("clone");
    expect(form.get("target_model")).toBe("qwen-audio-3.0-tts-plus");
    expect((form.get("file") as File).size).toBe(SAMPLE.byteLength);
    expect(voice.voiceId).toMatch(/^tv_/);
    expect(voiceCard.states[0]!.apiVoices).toEqual([expect.objectContaining({ model: "qwen-audio-3.0-tts-plus", voiceId: voice.voiceId, mode: "clone" })]);

    calls = [];
    const spoken = await voiceApi.speak(project.id, { text: "今晚的雨下得真大。", voiceCardId: card.id, addAsReference: true }, user);
    const speech = calls.find((c) => c.url.endsWith("/audio/speech"))!;
    expect(JSON.parse(String(speech.body))).toEqual({ model: "qwen-audio-3.0-tts-plus", input: "今晚的雨下得真大。", voice: voice.voiceId, response_format: "wav" });
    expect(calls.some((c) => c.url.includes("r2.cloudflarestorage.com") && c.method === "PUT")).toBe(true);
    expect(spoken.asset.kind).toBe("audio");
    expect(spoken.asset.meta).toMatchObject({ provider: "tokensail", model: "qwen-audio-3.0-tts-plus", voiceCardId: card.id, stateId: "young" });
    expect(spoken.chars).toBe(9);
    expect((await voiceApi.voicingStatus(project.id)).usedChars).toBe(9);
    expect((await repo.getVoiceCard(card.id)).states[0]!.refAssetIds).toContain(spoken.asset.id);
  });

  it("designs only with CosyVoice, from the state's description", async () => {
    const { project, card } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true }, user);
    await expect(voiceApi.createApiVoice(project.id, { voiceCardId: card.id, mode: "design" })).rejects.toThrow(/cosyvoice-v3.5/);
    await voiceApi.createApiVoice(project.id, { voiceCardId: card.id, mode: "design", model: "cosyvoice-v3.5-plus" });
    const form = calls.find((c) => c.url.endsWith("/audio/voices"))!.body as FormData;
    expect(form.get("prompt")).toBe("a young woman in her twenties, mezzo voice, clear and soft");
    expect(form.get("file")).toBeNull();
  });

  it("asks for a voice before speaking with a card, and keeps to the budget", async () => {
    const { project, card } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true, maxChars: 100 }, user);
    await expect(voiceApi.speak(project.id, { text: "你好", voiceCardId: card.id }, user)).rejects.toThrow(/create_api_voice/);
    await expect(voiceApi.speak(project.id, { text: "很".repeat(101) }, user)).rejects.toThrow(/budget/);
    expect(calls.filter((c) => c.url.endsWith("/audio/speech"))).toEqual([]);
  });

  it("passes experimental provider fields through, never over the Studio's own", async () => {
    const { project } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true }, user);
    await voiceApi.speak(project.id, { text: "你好。", model: "cosyvoice-v3.5-plus", voice: "tv_x", providerOptions: { instructions: "用愤怒的语气说", model: "other" }, inputOptions: { instruction: "愤怒" } }, user);
    const body = JSON.parse(String(calls.find((c) => c.url.endsWith("/audio/speech"))!.body));
    expect(body).toEqual({ instructions: "用愤怒的语气说", model: "cosyvoice-v3.5-plus", input: { instruction: "愤怒", text: "你好。" }, voice: "tv_x", response_format: "wav" });
  });

  it("transcribes an asset and scores it against the intended text", async () => {
    const { project, sample } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true }, user);
    const out = await voiceApi.transcribe(project.id, { assetId: sample.id, expectedText: "今晚的雨，下得真大！" });
    expect(out).toEqual({ text: "今晚的雨下得真大", model: "qwen-audio-3.0-asr-flash", cer: 0 });
    expect((calls.find((c) => c.url.endsWith("/audio/transcriptions"))!.body as FormData).get("model")).toBe("qwen-audio-3.0-asr-flash");
    expect(voiceApi.characterErrorRate("今晚的雨下得真大", "今晚的雨下得很大")).toBeCloseTo(0.125, 3);
  });

  it("deletes a voice and forgets it on the card", async () => {
    const { project, card } = await setup();
    await voiceApi.setVoicing(project.id, { enabled: true }, user);
    const { voice } = await voiceApi.createApiVoice(project.id, { voiceCardId: card.id, mode: "clone" });
    const out = await voiceApi.deleteApiVoice(project.id, voice.voiceId);
    expect(out.cardsUpdated).toContain(card.id);
    expect((await repo.getVoiceCard(card.id)).states[0]!.apiVoices).toEqual([]);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/audio/voices/${voice.voiceId}`))).toBe(true);
  });
});
