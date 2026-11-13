import { config } from "./config";
import { StudioError } from "./errors";
import * as repo from "./repo";
import type { ApiVoice } from "./schemas";
import { getObject, nameOfUploadKey, publicUrl, putObject, uploadKey } from "./storage/r2";
import type { Actor, Asset, VoiceCard, Voicing } from "./types";

/* Voices through the voice API: TokenSail's OpenAI-style audio endpoints
   (https://tokensail.ai/docs/api/audio), called from the Worker with its
   TOKENSAIL_API_KEY, the same key the face check and Qwen-Image use.

   - POST /v1/audio/voices makes a voice bound to one TTS model: `clone` from a
     sample (wav / mp3 / m4a, ≤ 10 MB; every TTS model) or `design` from a text
     description (≤ 500 characters; CosyVoice 3.5 only). It returns a `tv_` id.
     Each account holds 10 such voices by default.
   - POST /v1/audio/speech speaks text (≤ 4096 characters) with a voice: a `tv_`
     id, a system voice, or the model's default. Billed per character.
   - POST /v1/audio/transcriptions turns speech back into text (the
     pronunciation check). Billed per hour of audio.

   A project switches it on on the project's Settings page (web only) with a model and a
   character budget, as it does image generation. */

/* provider "tokensail": the voice API, billed per character, voices made once (clone or design) and kept on the card.
   provider "pod": Qwen3-TTS VoiceDesign on the Studio's GPU pod (voice-pod.ts): no stored voice, each line is spoken
   from the card state's description with the line's delivery after it, several takes to pick from. */
export type VoiceApiModel = { id: string; label: string; provider: "tokensail" | "pod"; modes: Array<"clone" | "design">; systemVoice: boolean; note: string };

export const POD_VOICE_MODEL = "qwen3-tts-voicedesign";

export const VOICE_API_MODELS: VoiceApiModel[] = [
  { id: "qwen-audio-3.0-tts-plus", label: "Qwen Audio 3.0 TTS Plus", provider: "tokensail", modes: ["clone"], systemVoice: true, note: "highest quality Qwen voice; clone from a sample, or a system voice" },
  { id: "qwen-audio-3.0-tts-flash", label: "Qwen Audio 3.0 TTS Flash", provider: "tokensail", modes: ["clone"], systemVoice: true, note: "faster, cheaper Qwen voice; clone from a sample, or a system voice" },
  { id: "cosyvoice-v3.5-plus", label: "CosyVoice 3.5 Plus", provider: "tokensail", modes: ["clone", "design"], systemVoice: false, note: "clone from a sample or design from a description" },
  { id: "cosyvoice-v3.5-flash", label: "CosyVoice 3.5 Flash", provider: "tokensail", modes: ["clone", "design"], systemVoice: false, note: "faster CosyVoice; clone or design" },
  { id: POD_VOICE_MODEL, label: "Qwen3-TTS VoiceDesign (our GPU)", provider: "pod", modes: [], systemVoice: false, note: "runs on the Studio's GPU pod while it is up: speaks each line from the voice card's description with the line's delivery (emotion) after it, several takes to pick from; the pronunciation check still uses TokenSail when its key is set" },
];
export const DEFAULT_VOICE_MODEL = "qwen-audio-3.0-tts-plus";
export const ASR_MODEL = "qwen-audio-3.0-asr-flash";
export const MAX_TTS_CHARS = 4096;
const MAX_SAMPLE_BYTES = 10 * 1048576;
const MAX_ASR_BYTES = 25 * 1048576;

const AUDIO_TYPES: Record<string, { ext: string; type: string }> = {
  mp3: { ext: "mp3", type: "audio/mpeg" }, wav: { ext: "wav", type: "audio/wav" }, opus: { ext: "ogg", type: "audio/ogg" },
};

export function voiceApiModel(id: string): VoiceApiModel | undefined {
  return VOICE_API_MODELS.find((m) => m.id === id);
}

/** The model a call would use: the one it names, else the project's choice. */
export async function projectVoiceModel(projectId: string, model?: string): Promise<VoiceApiModel | undefined> {
  return voiceApiModel(model ?? (await repo.getVoicing(projectId))?.model ?? DEFAULT_VOICE_MODEL);
}

/** Where the voice API is: TokenSail with the Worker's key, or undefined without one. */
export function voiceApi(): { base: string; key: string } | undefined {
  const key = process.env.TOKENSAIL_API_KEY;
  if (!key) return undefined;
  return { base: (process.env.TOKENSAIL_API_BASE || "https://api.tokensail.ai/v1").replace(/\/+$/, ""), key };
}

const DEFAULT_VOICING = (): Voicing => ({ enabled: false, model: DEFAULT_VOICE_MODEL, maxChars: 20000, usedChars: 0, grantedBy: "", grantedAt: 0 });

export async function voicingStatus(projectId: string) {
  const v = (await repo.getVoicing(projectId)) ?? DEFAULT_VOICING();
  const api = voiceApi();
  return {
    ...v,
    leftChars: Math.max(0, v.maxChars - v.usedChars),
    keyReady: !!api,
    note: api ? undefined : "the Worker has no TOKENSAIL_API_KEY (Cloudflare → Workers → the Studio → Settings → Variables and secrets)",
    models: VOICE_API_MODELS,
    asrModel: ASR_MODEL,
  };
}

/** Web only: the user switches voice generation on, picks the model and the character budget. */
export async function setVoicing(projectId: string, input: { enabled: boolean; model?: string; maxChars?: number; resetUsed?: boolean }, actor: Actor) {
  await repo.getProject(projectId);
  const current = (await repo.getVoicing(projectId)) ?? DEFAULT_VOICING();
  if (input.model && !voiceApiModel(input.model)) throw new StudioError("validation", `unknown voice model ${input.model}; one of ${VOICE_API_MODELS.map((m) => m.id).join(", ")}`);
  const turningOn = input.enabled && !current.enabled;
  await repo.setVoicingRow(projectId, {
    enabled: input.enabled,
    model: input.model ?? current.model,
    maxChars: input.maxChars ?? current.maxChars,
    usedChars: input.resetUsed ? 0 : current.usedChars,
    grantedBy: turningOn ? actor.user : current.grantedBy,
    grantedAt: turningOn ? Date.now() : current.grantedAt,
  });
  return voicingStatus(projectId);
}

async function requireVoicing(projectId: string, chars = 0): Promise<{ v: Voicing; api: { base: string; key: string } }> {
  const v = await requireVoicingOn(projectId, chars);
  const api = voiceApi();
  if (!api) throw new StudioError("validation", "the voice API needs TOKENSAIL_API_KEY as a Worker secret (Cloudflare → Workers → the Studio → Settings → Variables and secrets)");
  return { v, api };
}

/** Voice generation is on for the project and the budget has room for `chars` more characters (any provider). */
export async function requireVoicingOn(projectId: string, chars = 0): Promise<Voicing> {
  const v = await repo.getVoicing(projectId);
  if (!v?.enabled) throw new StudioError("forbidden", "voice generation is off for this project: the user switches it on on the project's Settings page (web only)");
  if (chars && v.usedChars + chars > v.maxChars) {
    throw new StudioError("validation", `this needs ${chars} characters and ${Math.max(0, v.maxChars - v.usedChars)} of the project's ${v.maxChars} are left; the user raises the budget on the project's Settings page`);
  }
  return v;
}

/** Count characters spoken against the project's budget. */
export async function spendChars(projectId: string, chars: number): Promise<void> {
  const latest = await repo.getVoicing(projectId);
  if (latest) await repo.setVoicingRow(projectId, { ...latest, usedChars: latest.usedChars + chars });
}

/** The provider's error envelope ({error: {code, message}}) as a Studio error. */
async function apiError(res: Response, what: string): Promise<StudioError> {
  let detail = "";
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string } };
    detail = [j.error?.code, j.error?.message].filter(Boolean).join(": ");
  } catch {
    detail = res.statusText;
  }
  const hint = res.status === 401 ? " (check TOKENSAIL_API_KEY)" : res.status === 402 ? " (the TokenSail balance is too low)" : res.status === 429 ? " (rate limited; try again shortly)" : "";
  return new StudioError("backend_error", `${what} failed: ${res.status} ${detail}${hint}`.trim());
}

async function assetBytes(asset: Asset): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string; filename: string }> {
  const key = typeof asset.meta?.key === "string" ? asset.meta.key : undefined;
  const res = key && config.r2Configured() ? await getObject(key) : await fetch(asset.url);
  if (!res.ok) throw new StudioError("backend_error", `could not read ${asset.id} (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const filename = (key ?? new URL(asset.url).pathname).split("/").pop() || `${asset.id}.wav`;
  const type = res.headers.get("content-type") || (filename.endsWith(".mp3") ? "audio/mpeg" : filename.endsWith(".m4a") ? "audio/mp4" : "audio/wav");
  return { bytes, type, filename };
}

function findState(card: VoiceCard, stateId?: string) {
  const id = stateId ?? card.defaultState ?? card.states[0]?.id;
  const state = card.states.find((s) => s.id === id);
  if (!state) throw new StudioError("validation", `voice card ${card.name} has no state "${id}" (${card.states.map((s) => s.id).join(", ")})`);
  return state;
}

/** Make a voice on the API from a card state: clone its reference audio, or design it from a description. */
export async function createApiVoice(projectId: string, input: { voiceCardId: string; stateId?: string; mode: "clone" | "design"; assetId?: string; prompt?: string; model?: string }) {
  const { v, api } = await requireVoicing(projectId);
  const card = await repo.getVoiceCard(input.voiceCardId);
  const state = findState(card, input.stateId);
  const model = input.model ?? v.model;
  const m = voiceApiModel(model);
  if (!m) throw new StudioError("validation", `unknown voice model ${model}`);
  if (m.provider === "pod") throw new StudioError("validation", `${m.label} keeps no voice: it speaks each line from the card state's description. Use speak (it returns a voice job with takes to pick from), or create_api_voice with a TokenSail model`);
  if (!m.modes.includes(input.mode)) throw new StudioError("validation", `${m.label} cannot ${input.mode} a voice; ${input.mode === "design" ? "designing from a description needs cosyvoice-v3.5-plus or cosyvoice-v3.5-flash" : "use a model that clones"}`);
  const form = new FormData();
  form.set("mode", input.mode);
  form.set("target_model", model);
  form.set("name", `${card.name} · ${state.name}`.slice(0, 64));
  let fromAssetId: string | undefined;
  if (input.mode === "clone") {
    fromAssetId = input.assetId ?? state.refAssetIds[0];
    if (!fromAssetId) throw new StudioError("validation", `state "${state.id}" has no reference audio to clone; pass assetId`);
    const asset = await repo.getAsset(fromAssetId);
    if (asset.kind !== "audio") throw new StudioError("validation", `${fromAssetId} is not audio`);
    const sample = await assetBytes(asset);
    if (sample.bytes.byteLength > MAX_SAMPLE_BYTES) throw new StudioError("validation", "a clone sample is at most 10 MB");
    form.set("file", new Blob([sample.bytes], { type: sample.type }), sample.filename);
  } else {
    const prompt = (input.prompt ?? state.description).trim();
    if (!prompt) throw new StudioError("validation", "designing a voice needs a description");
    form.set("prompt", prompt.slice(0, 500));
  }
  const res = await fetch(`${api.base}/audio/voices`, { method: "POST", headers: { authorization: `Bearer ${api.key}` }, body: form });
  if (!res.ok) throw await apiError(res, "creating the voice");
  const made = (await res.json()) as { id: string; status?: string };
  const voice: ApiVoice = { provider: "tokensail", model, voiceId: made.id, mode: input.mode, ...(fromAssetId ? { fromAssetId } : {}), createdAt: Date.now() };
  const states = card.states.map((s) => (s.id === state.id ? { ...s, apiVoices: [...s.apiVoices.filter((x) => x.model !== model), voice] } : s));
  const updated = await repo.updateVoiceCard(card.id, { states });
  return { voice, voiceCard: updated };
}

export function countChars(text: string): number {
  return [...text].length;
}

/** Speak text with a card state's API voice (or a named voice / the model's default) and keep it as an audio asset. */
export async function speak(projectId: string, input: { text: string; voiceCardId?: string; stateId?: string; voice?: string; model?: string; format?: "wav" | "mp3" | "opus"; label?: string; addAsReference?: boolean; providerOptions?: Record<string, unknown>; inputOptions?: Record<string, unknown> }, actor: Actor): Promise<{ asset: Asset; model: string; voice?: string; chars: number }> {
  const text = input.text.trim();
  if (!text) throw new StudioError("validation", "text is empty");
  const chars = countChars(text);
  if (chars > MAX_TTS_CHARS) throw new StudioError("validation", `at most ${MAX_TTS_CHARS} characters per call (got ${chars})`);
  const { v, api } = await requireVoicing(projectId, chars);
  if (!config.r2Configured()) throw new StudioError("backend_error", "R2 is not configured");
  let model = input.model ?? v.model;
  let voice = input.voice;
  let card: VoiceCard | undefined;
  let stateId: string | undefined;
  if (input.voiceCardId) {
    card = await repo.getVoiceCard(input.voiceCardId);
    const state = findState(card, input.stateId);
    stateId = state.id;
    const made = state.apiVoices.find((x) => x.model === model) ?? (input.model ? undefined : state.apiVoices[0]);
    if (!made) throw new StudioError("validation", `${card.name} · ${state.name} has no voice on ${model} yet: create_api_voice first (clone its reference audio, or design it)`);
    model = made.model;
    voice = made.voiceId;
  }
  const m = voiceApiModel(model);
  if (!m) throw new StudioError("validation", `unknown voice model ${model}`);
  if (m.provider === "pod") throw new StudioError("validation", `${m.label} runs on the GPU pod and answers with takes to pick from: use speakTakes (voice-pod.ts), which speak routes to`);
  const format = input.format ?? "wav";
  const res = await fetch(`${api.base}/audio/speech`, {
    method: "POST",
    headers: { authorization: `Bearer ${api.key}`, "content-type": "application/json" },
    body: JSON.stringify({ ...passThrough(input.providerOptions), model, input: input.inputOptions ? { ...passThrough(input.inputOptions), text } : text, ...(voice ? { voice } : {}), response_format: format }),
  });
  if (!res.ok) throw await apiError(res, "speech");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.byteLength) throw new StudioError("backend_error", "speech returned no audio");
  const t = AUDIO_TYPES[format]!;
  const base = (input.label ?? (card ? `${card.name}-${stateId}` : "speech")).replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 60);
  const key = uploadKey(actor.user, `${base}.${t.ext}`);
  await putObject(key, bytes, res.headers.get("content-type") || t.type);
  const asset = await repo.createAsset({
    projectId, url: publicUrl(key), kind: "audio", source: "generated",
    meta: { key, provider: "tokensail", model, ...(voice ? { voice } : {}), text, ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}), ...(input.inputOptions ? { inputOptions: input.inputOptions } : {}), ...(card ? { voiceCardId: card.id, stateId } : {}), requestId: res.headers.get("x-tokensail-request-id") ?? undefined },
    name: input.label ?? nameOfUploadKey(key),
  });
  await spendChars(projectId, chars);
  if (input.addAsReference && card && stateId) {
    await repo.updateVoiceCard(card.id, { states: card.states.map((s) => (s.id === stateId ? { ...s, refAssetIds: [...s.refAssetIds, asset.id].slice(-8) } : s)) });
  }
  return { asset, model, ...(voice ? { voice } : {}), chars };
}

/* Experimental fields passed to the provider as they are (an emotion or style instruction a model may take):
   never the ones the Studio sets itself. */
const RESERVED = new Set(["model", "input", "text", "voice", "response_format"]);
function passThrough(o: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !RESERVED.has(k)));
}

/** Speech back to text; with the intended text, the share of characters it got wrong (punctuation ignored). */
export async function transcribe(projectId: string, input: { assetId: string; expectedText?: string }) {
  const { api } = await requireVoicing(projectId);
  const asset = await repo.getAsset(input.assetId);
  if (asset.kind !== "audio" && asset.kind !== "video") throw new StudioError("validation", `${input.assetId} is not audio or video`);
  const text = await transcribeBytes(api, await assetBytes(asset));
  return { text, model: ASR_MODEL, ...(input.expectedText !== undefined ? { cer: characterErrorRate(input.expectedText, text) } : {}) };
}

/** The pronunciation check on raw audio (TokenSail's ASR): what it heard. */
export async function transcribeBytes(api: { base: string; key: string }, audio: { bytes: Uint8Array<ArrayBuffer>; type: string; filename: string }): Promise<string> {
  if (audio.bytes.byteLength > MAX_ASR_BYTES) throw new StudioError("validation", "transcription takes at most 25 MB");
  const form = new FormData();
  form.set("model", ASR_MODEL);
  form.set("file", new Blob([audio.bytes], { type: audio.type }), audio.filename);
  const res = await fetch(`${api.base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${api.key}` }, body: form });
  if (!res.ok) throw await apiError(res, "transcription");
  return String(((await res.json()) as { text?: string }).text ?? "");
}

/** Character error rate between the intended and the heard text, ignoring punctuation, spaces and case. */
export function characterErrorRate(expected: string, heard: string): number {
  const norm = (s: string) => [...s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")];
  const a = norm(expected), b = norm(heard);
  if (!a.length) return b.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return Math.round((prev[b.length]! / a.length) * 1000) / 1000;
}

/** The account's voices on the API (10 by default: delete the ones no card needs). */
export async function listApiVoices(projectId: string) {
  const { api } = await requireVoicing(projectId);
  const res = await fetch(`${api.base}/audio/voices`, { headers: { authorization: `Bearer ${api.key}` } });
  if (!res.ok) throw await apiError(res, "listing voices");
  return ((await res.json()) as { data?: unknown[] }).data ?? [];
}

/** Delete a voice on the API and forget it on every card that used it. */
export async function deleteApiVoice(projectId: string, voiceId: string) {
  const { api } = await requireVoicing(projectId);
  if (!/^tv_[a-z0-9]+$/.test(voiceId)) throw new StudioError("validation", "voiceId is a tv_ id");
  const res = await fetch(`${api.base}/audio/voices/${voiceId}`, { method: "DELETE", headers: { authorization: `Bearer ${api.key}` } });
  if (!res.ok && res.status !== 404) throw await apiError(res, "deleting the voice");
  const cards = await repo.voiceCardsWithApiVoice(voiceId);
  for (const c of cards) await repo.updateVoiceCard(c.id, { states: c.states.map((s) => ({ ...s, apiVoices: s.apiVoices.filter((x) => x.voiceId !== voiceId) })) });
  return { deleted: voiceId, cardsUpdated: cards.map((c) => c.id) };
}
