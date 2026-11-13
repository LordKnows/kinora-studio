import type { BackendStatus } from "./backends/types";
import { signHookUrl } from "./backends/runpod";
import { config } from "./config";
import { StudioError } from "./errors";
import * as gpu from "./gpu";
import * as repo from "./repo";
import { getObject, publicUrl } from "./storage/r2";
import type { Actor, Asset, VoiceCard, VoiceJob, VoiceTake, VoiceTakeFlag } from "./types";
import * as voiceApi from "./voice-api";

/* Qwen3-TTS VoiceDesign on the Studio's GPU pod (workers/h3-runpod/voice_handler.py).

   The model builds a voice from a written description every time it speaks: the
   voice card state's description, with the line's delivery after it ("Emotion and
   delivery: furious, voice raised"). That is what gives it strong emotion, and also
   why it does not hold one voice by itself: the same description gives a slightly
   different person from one seed to the next. So a line is spoken several times,
   one take per seed, and the user picks one by ear. Two checks mark the takes and
   never choose for the user:

   - off_voice: the take's speaker embedding (WeSpeaker, on the pod) is far from the
     card state's reference audio — the voice drifted. Clips are short, so the floor
     is low and only catches the clear misses.
   - misread: TokenSail's ASR heard other words than the line (when its key is set).

   The picked take becomes an audio asset with its seed and description, so it can
   be made again; it can go on the card as a reference and onto the line it was made
   for (Line.audioAssetId). */

export const POD_VOICE_MODEL = voiceApi.POD_VOICE_MODEL;
export const DEFAULT_TAKES = 4;
export const MAX_TAKES = 8;
/** WeSpeaker cosine against the reference below which a take is flagged off_voice (2–5 s clips score low). */
export const SIMILARITY_FLOOR = 0.5;
/** Character error rate above which a take is flagged misread (a dropped or extra character on a short line passes). */
export const CER_LIMIT = 0.1;
const MAX_TEXT = 400;
const MAX_INSTRUCT = 1000;

const LANGUAGES: Record<string, string> = {
  zh: "Chinese", en: "English", ja: "Japanese", ko: "Korean", de: "German", fr: "French", ru: "Russian", pt: "Portuguese", es: "Spanish", it: "Italian",
};

export function podLanguage(code: string): string {
  const base = code.toLowerCase().split(/[-_]/)[0] ?? "";
  const name = LANGUAGES[base];
  if (!name) throw new StudioError("validation", `Qwen3-TTS VoiceDesign speaks ${Object.keys(LANGUAGES).join(", ")}; not "${code}"`);
  return name;
}

/** The description the model speaks from: the voice, then the line's delivery (left out when neutral). */
export function buildInstruct(description: string, delivery?: string): string {
  const voice = description.trim().replace(/[\s.。]+$/u, "");
  if (!voice) throw new StudioError("validation", "speaking with Qwen3-TTS VoiceDesign needs a voice description: the card state's, or pass one");
  const d = (delivery ?? "").trim();
  const out = d && !/^neutral$/i.test(d) ? `${voice}. Emotion and delivery: ${d}` : voice;
  if (out.length > MAX_INSTRUCT) throw new StudioError("validation", `the voice description and delivery come to ${out.length} characters; at most ${MAX_INSTRUCT}`);
  return out;
}

function randomSeeds(n: number): number[] {
  const seeds = new Set<number>();
  const buf = new Uint32Array(1);
  while (seeds.size < n) {
    crypto.getRandomValues(buf);
    seeds.add(buf[0]! % 2 ** 31);
  }
  return [...seeds];
}

function findState(card: VoiceCard, stateId?: string) {
  const id = stateId ?? card.defaultState ?? card.states[0]?.id;
  const state = card.states.find((s) => s.id === id);
  if (!state) throw new StudioError("validation", `voice card ${card.name} has no state "${id}" (${card.states.map((s) => s.id).join(", ")})`);
  return state;
}

/** The first audio among the state's references: what the takes are scored against. */
async function anchorOf(refAssetIds: string[]): Promise<Asset | undefined> {
  for (const id of refAssetIds) {
    const a = await repo.getAsset(id).catch(() => undefined);
    if (a?.kind === "audio") return a;
  }
  return undefined;
}

/** The running pod's job server, ready to speak; otherwise a plain error that says what to do. */
async function voiceBackend() {
  if (config.runpodMode() !== "pod" || !gpu.gpuConfigured()) {
    throw new StudioError("validation", "Qwen3-TTS VoiceDesign runs on the Studio's GPU pod: it needs the pod mode (RUNPOD_MODE=pod) and a configured pod");
  }
  const pod = await repo.currentGpuPod();
  if (!pod || pod.status !== "running" || !pod.hostUrl) {
    throw new StudioError("validation", "the GPU pod is not running: start it (the GPU panel, or gpu_start) and speak again once it is up", { gpu: pod?.status ?? "none" });
  }
  await gpu.assertPodCanWork("a voice job");
  const voice = await gpu.podVoiceStatus();
  if (!voice) throw new StudioError("backend_error", "the GPU pod does not answer yet; try again in a minute", { unreachable: true });
  if (!voice.ready) throw new StudioError("validation", `the GPU pod cannot speak yet: ${voice.why ?? "not ready"}`, { voice });
  return gpu.podBackend(pod, "voice");
}

export type SpeakTakesInput = {
  text: string;
  voiceCardId?: string;
  stateId?: string;
  /** a voice description to use instead of the card state's */
  description?: string;
  /** the line's emotion and delivery, after the description; "neutral" adds nothing */
  delivery?: string;
  /** language code (zh, en, …); default: the project's dialogue language */
  language?: string;
  takes?: number;
  seeds?: number[];
  shotId?: string;
  lineIndex?: number;
};

/** Speak a line several times on the GPU pod; returns the voice job (the takes come back on its webhook). */
export async function speakTakes(projectId: string, input: SpeakTakesInput, actor: Actor): Promise<VoiceJob> {
  const text = input.text.trim();
  if (!text) throw new StudioError("validation", "text is empty");
  const chars = voiceApi.countChars(text);
  if (chars > MAX_TEXT) throw new StudioError("validation", `at most ${MAX_TEXT} characters a line on Qwen3-TTS VoiceDesign (got ${chars})`);
  const seeds = input.seeds?.length ? input.seeds : randomSeeds(Math.min(Math.max(input.takes ?? DEFAULT_TAKES, 1), MAX_TAKES));
  if (seeds.length > MAX_TAKES || new Set(seeds).size !== seeds.length || !seeds.every((s) => Number.isInteger(s) && s >= 0 && s < 2 ** 31)) {
    throw new StudioError("validation", `seeds: 1–${MAX_TAKES} different integers in [0, 2^31)`);
  }
  await voiceApi.requireVoicingOn(projectId, chars * seeds.length);
  if (!config.r2Configured()) throw new StudioError("backend_error", "R2 is not configured");

  let card: VoiceCard | undefined;
  let stateId: string | undefined;
  let description = input.description;
  let anchor: Asset | undefined;
  if (input.voiceCardId) {
    card = await repo.getVoiceCard(input.voiceCardId);
    const state = findState(card, input.stateId);
    stateId = state.id;
    description ??= state.description;
    anchor = await anchorOf(state.refAssetIds);
  }
  const instruct = buildInstruct(description ?? "", input.delivery);
  const project = await repo.getProject(projectId);
  const language = podLanguage(input.language ?? project.look?.dialogueLanguage ?? "zh");

  const backend = await voiceBackend();
  let job = await repo.createVoiceJob({
    projectId, model: POD_VOICE_MODEL, text, language, instruct, seeds,
    ...(input.delivery && !/^neutral$/i.test(input.delivery.trim()) ? { delivery: input.delivery.trim() } : {}),
    ...(card ? { voiceCardId: card.id, stateId } : {}), ...(anchor ? { anchorAssetId: anchor.id } : {}),
    ...(input.shotId ? { shotId: input.shotId } : {}), ...(input.lineIndex !== undefined ? { lineIndex: input.lineIndex } : {}),
    createdBy: actor.user,
  });
  const webhook = await signHookUrl(config.publicUrl(), "/api/voice/hook", config.runpod().webhookSecret, job.id);
  try {
    const { requestId } = await backend.submit({
      text, language, instruct, seeds, anchor_url: anchor?.url ?? null,
      output: { prefix: `projects/${projectId}/voice/${job.id}` }, studio_voice_job_id: job.id,
    }, { webhook });
    job = await repo.updateVoiceJob(job.id, { status: "running", backendJobId: requestId });
  } catch (caught) {
    await repo.updateVoiceJob(job.id, { status: "failed", error: caught instanceof Error ? caught.message : String(caught) });
    throw caught;
  }
  await voiceApi.spendChars(projectId, chars * seeds.length);
  await gpu.touchGpuActivity().catch(() => undefined);
  return job;
}

/** Speak a shot's dialogue line: its text, the speaker's voice card and state, its delivery and language. */
export async function speakLine(projectId: string, shotId: string, lineIndex: number, opts: { takes?: number; seeds?: number[] }, actor: Actor): Promise<VoiceJob> {
  const shot = await repo.getShot(shotId);
  if (shot.projectId !== projectId) throw new StudioError("validation", `shot ${shotId} is not in this project`);
  const line = shot.spec.dialogue?.[lineIndex];
  if (!line) throw new StudioError("validation", `shot ${shotId} has no line ${lineIndex} (it has ${shot.spec.dialogue?.length ?? 0})`);
  const speaker = await repo.getElement(line.speaker);
  if (!speaker.voiceCardId) throw new StudioError("validation", `${speaker.name} has no voice card: give the element one (update_element voiceCardId) first`);
  return speakTakes(projectId, {
    text: line.text, voiceCardId: speaker.voiceCardId, stateId: line.voiceState ?? speaker.voiceState, delivery: line.delivery,
    ...(line.language ? { language: line.language } : {}), shotId, lineIndex, ...opts,
  }, actor);
}

/* ---------- results ---------- */

type PodTake = { seed?: unknown; url?: unknown; key?: unknown; duration_s?: unknown; similarity?: unknown };

async function heardText(api: { base: string; key: string }, take: VoiceTake): Promise<string | undefined> {
  try {
    const res = config.r2Configured() ? await getObject(take.key) : await fetch(take.url);
    if (!res.ok) return undefined;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return await voiceApi.transcribeBytes(api, { bytes, type: "audio/wav", filename: take.key.split("/").pop() || "take.wav" });
  } catch {
    return undefined;
  }
}

/** Apply what the pod says about a voice job: on completion, the takes with their checks. */
export async function applyVoiceJobStatus(job: VoiceJob, status: BackendStatus): Promise<VoiceJob> {
  if (job.status !== "queued" && job.status !== "running") return job;
  switch (status.state) {
    case "queued":
      return job.status === "queued" ? job : repo.updateVoiceJob(job.id, { status: "queued" });
    case "running":
      return job.status === "running" ? job : repo.updateVoiceJob(job.id, { status: "running" });
    case "failed":
    case "timeout":
      return repo.updateVoiceJob(job.id, { status: "failed", error: status.state === "failed" ? status.error : "the pod did not finish in time" });
    case "canceled":
      return repo.updateVoiceJob(job.id, { status: "cancelled" });
    case "completed": {
      const raw = Array.isArray(status.output.takes) ? (status.output.takes as PodTake[]) : [];
      const api = voiceApi.voiceApi();
      const takes: VoiceTake[] = [];
      for (const [i, t] of raw.entries()) {
        if (typeof t.key !== "string" || typeof t.url !== "string") continue;
        const similarity = typeof t.similarity === "number" ? t.similarity : null;
        const take: VoiceTake = {
          index: i + 1, seed: Number(t.seed), key: t.key, url: config.r2Configured() ? publicUrl(t.key) : t.url,
          ...(typeof t.duration_s === "number" ? { durationS: t.duration_s } : {}), similarity, flags: [],
        };
        const flags: VoiceTakeFlag[] = [];
        if (similarity !== null && similarity < SIMILARITY_FLOOR) flags.push("off_voice");
        const heard = api ? await heardText(api, take) : undefined;
        if (heard !== undefined) {
          take.heard = heard;
          take.cer = voiceApi.characterErrorRate(job.text, heard);
          if (take.cer > CER_LIMIT) flags.push("misread");
        }
        takes.push({ ...take, flags });
      }
      if (!takes.length) return repo.updateVoiceJob(job.id, { status: "failed", error: "the pod finished with no takes" });
      return repo.updateVoiceJob(job.id, { status: "done", takes, ...(status.executionMs !== undefined ? { executionMs: status.executionMs } : {}) });
    }
  }
}

/** Ask the pod about a voice job that is still out; leave it be when the pod does not answer. */
export async function refreshVoiceJob(id: string): Promise<VoiceJob> {
  const job = await repo.getVoiceJob(id);
  if ((job.status !== "queued" && job.status !== "running") || !job.backendJobId) return job;
  const pod = await repo.currentGpuPod();
  if (!pod?.hostUrl || pod.status !== "running") {
    /* the pod went away with the job on it */
    if (!pod || pod.status === "stopped" || pod.status === "terminated") return repo.updateVoiceJob(id, { status: "failed", error: "the GPU pod stopped before the takes came back; speak again once it is up" });
    return job;
  }
  try {
    return await applyVoiceJobStatus(job, await gpu.podBackend(pod, "voice").status(job.backendJobId));
  } catch (caught) {
    if (caught instanceof StudioError && caught.code === "backend_error") return job;
    throw caught;
  }
}

/** A voice job; with wait, keep asking the pod (every 2 s, up to wait seconds, at most 60) until its takes are back. */
export async function getVoiceJob(projectId: string, id: string, opts: { wait?: number } = {}): Promise<VoiceJob> {
  let job = await repo.getVoiceJob(id);
  if (job.projectId !== projectId) throw new StudioError("not_found", `voice job ${id} not found in this project`);
  const until = Date.now() + Math.min(Math.max(opts.wait ?? 0, 0), 60) * 1000;
  for (;;) {
    job = await refreshVoiceJob(id);
    if ((job.status !== "queued" && job.status !== "running") || Date.now() >= until) return job;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function listVoiceJobs(projectId: string, opts: { shotId?: string; limit?: number } = {}): Promise<VoiceJob[]> {
  return repo.listVoiceJobs(projectId, opts);
}

/** The sweep: ask after voice jobs still out (the webhook normally answers first). */
export async function sweepVoiceJobs(): Promise<number> {
  let changed = 0;
  for (const job of await repo.listActiveVoiceJobs()) {
    if (Date.now() - job.createdAt > 30 * 60_000) {
      await repo.updateVoiceJob(job.id, { status: "failed", error: "no answer from the GPU pod within 30 minutes" });
      changed++;
      continue;
    }
    try {
      if ((await refreshVoiceJob(job.id)).status !== job.status) changed++;
    } catch {
      /* next sweep */
    }
  }
  return changed;
}

/* ---------- picking ---------- */

export type PickInput = { take: number; addAsReference?: boolean; attachToLine?: boolean; label?: string };

/** Keep one take: it becomes an audio asset (with its seed and description, so it can be made again), and
    optionally a reference on the card state and the audio of the line it was made for. */
export async function pickVoiceTake(projectId: string, id: string, input: PickInput, actor: Actor): Promise<{ job: VoiceJob; asset: Asset; attachedTo?: { shotId: string; lineIndex: number } }> {
  const job = await repo.getVoiceJob(id);
  if (job.projectId !== projectId) throw new StudioError("not_found", `voice job ${id} not found in this project`);
  if (job.status !== "done") throw new StudioError("validation", `voice job ${id} is ${job.status}; its takes are not back yet`);
  const take = job.takes.find((t) => t.index === input.take);
  if (!take) throw new StudioError("validation", `voice job ${id} has takes ${job.takes.map((t) => t.index).join(", ")}; not ${input.take}`);
  let asset = job.pickedAssetId && job.picked === take.index ? await repo.getAsset(job.pickedAssetId).catch(() => undefined) : undefined;
  if (!asset) {
    const card = job.voiceCardId ? await repo.getVoiceCard(job.voiceCardId).catch(() => undefined) : undefined;
    const name = input.label ?? `${card ? `${card.name}${job.stateId ? `-${job.stateId}` : ""}` : "line"}-take${take.index}`;
    asset = await repo.createAsset({
      projectId, url: take.url, kind: "audio", source: "generated", name,
      meta: {
        key: take.key, provider: "pod", model: job.model, text: job.text, language: job.language, instruct: job.instruct, seed: take.seed,
        ...(job.delivery ? { delivery: job.delivery } : {}), similarity: take.similarity, ...(take.heard !== undefined ? { heard: take.heard, cer: take.cer } : {}),
        ...(job.voiceCardId ? { voiceCardId: job.voiceCardId, stateId: job.stateId } : {}), voiceJobId: job.id, pickedBy: actor.user,
      },
    });
  }
  const updated = await repo.updateVoiceJob(job.id, { picked: take.index, pickedAssetId: asset.id });
  if (input.addAsReference && job.voiceCardId && job.stateId) {
    const card = await repo.getVoiceCard(job.voiceCardId);
    await repo.updateVoiceCard(card.id, { states: card.states.map((s) => (s.id === job.stateId && !s.refAssetIds.includes(asset!.id) ? { ...s, refAssetIds: [...s.refAssetIds, asset!.id].slice(-8) } : s)) });
  }
  let attachedTo: { shotId: string; lineIndex: number } | undefined;
  if (input.attachToLine) {
    if (!job.shotId || job.lineIndex === undefined) throw new StudioError("validation", "this voice job was not made for a shot's line (speak_line makes one that is)");
    const shot = await repo.getShot(job.shotId);
    const line = shot.spec.dialogue?.[job.lineIndex];
    if (!line || line.text.trim() !== job.text) throw new StudioError("validation", `line ${job.lineIndex} of shot ${job.shotId} has changed since these takes were made; speak it again`);
    const dialogue = shot.spec.dialogue.map((l, i) => (i === job.lineIndex ? { ...l, audioAssetId: asset!.id } : l));
    await repo.updateShot(shot.id, { spec: { ...shot.spec, dialogue } });
    attachedTo = { shotId: shot.id, lineIndex: job.lineIndex };
  }
  return { job: updated, asset, ...(attachedTo ? { attachedTo } : {}) };
}
