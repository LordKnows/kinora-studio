import { assertBudget, assertCanGenerate, assertConfirmed } from "./checkpoints";
import { hashOf } from "./craft-core";
import { autopilotCovers, consumeAutopilot, reviewState } from "./craft-core";
import { estimateTake, reservedUsd } from "./cost";
import { StudioError } from "./errors";
import * as gpu from "./gpu";
import { submitTake } from "./orchestrator";
import * as repo from "./repo";
import type { Actor, Element, Take } from "./types";
import type { ShotInput } from "./schemas";

/*
 * Viggle Remake: a finished take re-shot from 1-4 painted frames. The motion,
 * camera and timing of the take stay; what the painted frames and the
 * retention_analysis say changes, changes. Two modes (two LoRAs): edit
 * (objects, props, wardrobe, background, weather, light, style) and swap
 * (people and characters). The prompt is MiniMax-H3's six sections, written
 * as a description of the target video, not as an instruction
 * (Viggle-Remake PROMPTING.md). The result is a new take of the same shot.
 */

export type RemakeChange = {
  /** What in the source this is about, precise enough to exclude everyone similar ("the man in the grey coat on frame right"). */
  subject: string;
  /** How it is in the target video, as a description ("he wears a red wool beret in every frame, as in <Picture 1>"). */
  target: string;
  /** removed | changed (default changed) */
  fate?: "changed" | "removed";
};

export type RemakeKeyframe = { assetId: string; frame: number };

/** 17n+5 frames that fit inside the take, between 90 and 345. */
export function remakeFrames(outputSeconds: number): number {
  const avail = Math.floor(outputSeconds * 24 + 1e-6);
  const n = Math.floor((Math.min(avail, 345) - 5) / 17);
  return Math.max(90, 17 * n + 5);
}

function ts(frame: number): string {
  const s = frame / 24;
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}

/** The six-section prompt. */
export function remakePrompt(input: { spec: ShotInput; elements: Map<string, Element>; mode: "edit" | "swap"; changes: RemakeChange[]; keyframes: RemakeKeyframe[]; frames: number; lookLine?: string }): string {
  const { spec, changes, keyframes, frames } = input;
  const pics = keyframes.map((_k, i) => `<Picture ${i + 1}> is a frame of the target video, exactly as the target video shows it at that moment.`);
  const subjects = changes.map((c, i) => `<Subject ${i + 1}> is ${c.subject}.`);
  const keepIndex = changes.length + 1;
  const keep = `<Subject ${keepIndex}> is everything else in <Video 1>: the setting, the other people and objects, the light and the camera.`;
  const name = (id: string) => input.elements.get(id)?.name ?? id;
  const who = spec.characters.length ? ` with ${spec.characters.map(name).join(" and ")}` : "";
  const summary = `[video ${input.mode === "swap" ? "character replacement" : "editing"}] The target video is ${input.mode === "swap" ? "a recast" : "an edited"} version of <Video 1>: ${spec.intent}${who}. The camera, framing, every movement and the timing are exactly as in <Video 1>; what differs: ${changes.map((c) => c.target).join("; ")}.`;
  const retention = [
    `<Video 1> (source video ${input.mode === "swap" ? "character replacement" : "editing"}): fully_preserved - the framing, the camera move, everyone's motion, the actions and their timing are copied frame for frame.`,
    ...keyframes.map((_k, i) => `<Picture ${i + 1}> (target keyframe): fully_preserved - the target video passes through this exact frame.`),
    ...changes.map((c, i) => `<Subject ${i + 1}> (appears in [Shot 1]): ${c.fate === "removed" ? "removed" : "changed"} - ${c.target}`),
    `<Subject ${keepIndex}> (appears in [Shot 1]): fully_preserved - retained exactly as in <Video 1>.`,
  ];
  const end = ts(frames - 1);
  const beats = spec.beats.map((b) => b.action.trim().replace(/\.?$/, ".")).join(" ");
  const anchors = keyframes.map((k, i) => `At ${ts(k.frame)} the scene matches <Picture ${i + 1}>.`).join(" ");
  const detail = `${input.lookLine ? `${input.lookLine} ` : ""}No text and no lettering anywhere.\n[Shot 1] From 00:00.000 to ${end}, exactly as in <Video 1>: ${beats} ${changes.map((c) => c.target).join(" ")} ${anchors}`.trim();
  return [
    `subject_definitions:\n<Video 1> is the source video for the target video ${input.mode === "swap" ? "character replacement" : "edit"}.\n${[...pics, ...subjects, keep].join("\n")}`,
    `summary:\n${summary}`,
    `retention_analysis:\n${retention.join("\n")}`,
    `detailed_description:\n${detail}`,
    "overall_soundscape:\nThe soundtrack of <Video 1>, unchanged.",
    "non_diegetic_music:\nN/A",
  ].join("\n\n");
}

/** Render a Remake of a finished take as a new take of the same shot. */
export async function remakeTake(takeId: string, input: { mode: "edit" | "swap"; keyframes: Array<{ assetId: string; frame?: number }>; changes?: RemakeChange[]; prompt?: string; shortEdge?: 480 | 736; seed?: number; confirm?: boolean }, actor: Actor): Promise<{ take: Take; estimateUsd: number; prompt: string; frames: number; warnings: string[] }> {
  const source = await repo.getTake(takeId);
  if (source.status !== "completed" || !source.resultUrl) throw new StudioError("validation", "remake a completed take");
  const shot = await repo.getShot(source.shotId);
  const project = await repo.getProject(source.projectId);
  assertCanGenerate(project, await repo.latestScript(project.id));
  if (!input.keyframes.length || input.keyframes.length > 4) throw new StudioError("validation", "give 1-4 painted keyframes");
  const assets = await repo.getAssets(input.keyframes.map((k) => k.assetId));
  const frames = remakeFrames(source.outputSeconds ?? shot.spec.durationS);
  const keyframes: RemakeKeyframe[] = [];
  for (const k of input.keyframes) {
    const a = assets.get(k.assetId);
    if (!a || a.kind !== "image") throw new StudioError("validation", `keyframe ${k.assetId} is not a project image`);
    /* an edited extract remembers its frame through its base */
    let frame = k.frame ?? (typeof a.meta.frame === "number" ? a.meta.frame : undefined);
    if (frame === undefined && typeof a.meta.baseAssetId === "string") {
      const base = await repo.getAsset(a.meta.baseAssetId).catch(() => undefined);
      if (base && typeof base.meta.frame === "number") frame = base.meta.frame;
    }
    if (frame === undefined) throw new StudioError("validation", `keyframe ${k.assetId}: say which source frame it was painted from (frame)`);
    if (frame >= frames) throw new StudioError("validation", `keyframe frame ${frame} is past the remake's ${frames} frames`);
    keyframes.push({ assetId: a.id, frame });
  }
  const elements = await repo.getElements([...shot.spec.characters, ...shot.spec.props, ...(shot.spec.location ? [shot.spec.location] : [])]);
  let prompt = input.prompt?.trim() ?? "";
  if (!prompt) {
    if (!input.changes?.length) throw new StudioError("validation", "say what changes (changes: [{subject, target}]) or pass a full six-section prompt");
    prompt = remakePrompt({ spec: shot.spec, elements, mode: input.mode, changes: input.changes, keyframes, frames, lookLine: [project.look.genre, project.look.palette].filter(Boolean).join(". ") || undefined });
  }
  if (!prompt.includes("retention_analysis")) throw new StudioError("validation", "the prompt must be the six-section format (subject_definitions … non_diegetic_music)");

  const estimate = estimateTake(frames / 24, 12, 1, await gpu.measuredForEstimate());
  assertBudget(project, estimate.usd + reservedUsd(await repo.listProjectActiveTakes(project.id)));
  /* the painted keyframes should each have passed a frame review before money is spent */
  const states = await Promise.all(keyframes.map((k) => reviewState(project.id, "frame", hashOf(assets.get(k.assetId)!.url), k.assetId)));
  const unreviewed = keyframes.filter((_k, i) => states[i]!.state !== "pass");
  const warnings = unreviewed.length ? [`${unreviewed.length} keyframe(s) without a passing frame review: review_packet(stage 'frame', assetId) → a fresh reviewer → record_review`] : [];
  if (actor.via === "mcp" && !input.confirm) {
    if (!unreviewed.length && autopilotCovers(project, estimate.usd)) await consumeAutopilot(project, estimate.usd, `Remake (${input.mode}) of take #${source.n}`, "keyframes passed their frame reviews; inside the envelope", shot.id);
    else assertConfirmed(false, estimate.usd, `a Remake (${input.mode}) of take #${source.n}`);
  }
  const seed = input.seed ?? 0;
  const created = await repo.createTake({
    projectId: project.id, shotId: shot.id, backend: "runpod", workflow: "REMAKE", prompt,
    input: {
      workflow: "REMAKE", mode: input.mode, video: source.resultUrl, prompt, refs: keyframes.map((k) => assets.get(k.assetId)!.url), pins: keyframes.map((k) => k.frame),
      frames, short_edge: input.shortEdge ?? 736, seed, seconds: frames / 24,
      studio_remake: { sourceTakeId: source.id, sourceN: source.n, mode: input.mode, keyframes, changes: input.changes ?? [] },
    },
    seed,
  });
  const withKey = await repo.updateTake(created.id, { input: { ...created.input, studio_take_id: created.id, output: { key: `projects/${project.id}/shots/${shot.id}/takes/${created.id}.mp4` } } });
  if (config_isPod()) {
    const pod = await repo.currentGpuPod();
    if (!pod || pod.status !== "running") {
      const state = await gpu.startGpu(actor, true);
      if (state.status === "unavailable") throw new StudioError("backend_error", state.message ?? "no GPU available right now", { noResources: true });
    }
  }
  return { take: await submitTake(withKey), estimateUsd: estimate.usd, prompt, frames, warnings };
}

function config_isPod(): boolean {
  return (process.env.RUNPOD_MODE ?? "pod") !== "serverless";
}
