import { z } from "zod";

import { buildCanvasPrompt, CANVAS_MAX_REFS, CANVAS_MAX_REFS_ANY, CANVAS_SIZES, CANVAS_STYLE_IDS, type CanvasPromptRecipe } from "./canvas-prompt";
import { StudioError } from "./errors";
import * as imaging from "./imaging";
import { importImageFromUrl } from "./images";
import * as painter from "./painter";
import { findModel, IMAGE_MODELS, projectImageModel, resolveParams, type ModelEntry } from "./models";
import { firstUploadIn } from "./provenance";
import { adultAllowed, getReference } from "./references";
import { referenceImage, referenceName, type RefCostume, type RefItem, type RefKind, type RefPortrait, type RefPose } from "./references-model";
import * as repo from "./repo";
import { LoraRef, REF_VIEWS } from "./schemas";
import type { Actor, Asset, Job } from "./types";

/*
 * Canvas: compose one character picture from the reference library —
 * a portrait (face, hair), a costume, a pose, more pictures up to what the
 * model takes — drawn by a painter like every other Studio picture: GPT
 * Image (Codex or the API), Qwen-Image 3.0 Pro through an API (TokenSail
 * or DashScope, on the CPU painter pod), or an image model on the GPU pod (Qwen-Image
 * 2.1 Turbo / base, Qwen-Image-Edit 2509 in ComfyUI, models.ts) while the
 * pod runs. The pose can be flipped left to right (the painter mirrors the
 * picture before drawing). The
 * result is a project picture (IMG-n) with its recipe in meta.canvas, and
 * can go straight onto a character as a reference view.
 *
 * The references are the galleries' own URLs: the painter downloads the
 * few pictures a job uses, nothing is mirrored. "Add to pictures" imports a
 * single reference picture into the project, for use as an element ref.
 */

const Slot = z.object({ id: z.string().max(80).optional(), assetId: z.string().max(80).optional() });
const Quality = z.enum(["low", "medium", "high"]);

export const CanvasCompose = z.object({
  portrait: Slot.optional(),
  costume: Slot.extend({ view: z.string().max(20).optional() }).optional(),
  pose: Slot.extend({ depth: z.boolean().default(false), mirror: z.boolean().default(false).describe("Flip the pose picture left to right (the pose turned the other way)") }).optional(),
  model: z.enum(IMAGE_MODELS.map((m) => m.id) as [string, ...string[]]).optional().describe("Image model (list_models): gpt-image-codex, gpt-image-api, qwen-image-3.0-pro (API, CPU painter pod, up to 3 pictures), or on the GPU pod qwen-image-2.1-turbo, qwen-image-2.1, qwen-image-edit-2509 (pose + portrait and/or costume). Omit for the project's model (Settings → Director)."),
  promptExtend: z.boolean().default(false).describe("Qwen-Image 3.0 Pro: let the vendor rewrite the prompt (prompt_extend; off keeps the composed 图1/图2/图3 roles as written)"),
  negativePrompt: z.string().max(500).optional().describe("Qwen-Image 3.0 Pro: what the picture must not show"),
  extras: z.array(z.object({ assetId: z.string().max(80), name: z.string().max(60).default("") })).max(CANVAS_MAX_REFS_ANY).default([]),
  seed: z.number().int().min(0).max(2 ** 48).optional().describe("Pod models: a fixed seed (else random)"),
  loras: z.array(LoraRef).max(4).default([]).describe("Pod models: LoRAs from the library trained for the model's family (list_models); picking one applies its card's settings (ChatR Omni on Qwen-Image 2.1: 35 steps, CFG 5)"),
  style: z.enum(CANVAS_STYLE_IDS).default("realistic"),
  note: z.string().max(600).optional().describe("Free text added to the composed prompt"),
  prompt: z.string().min(5).max(4000).optional().describe("Replace the composed prompt entirely"),
  size: z.enum(CANVAS_SIZES).default("1024x1536"),
  quality: Quality.optional(),
  attach: z.object({ elementId: z.string(), view: z.enum(REF_VIEWS).default("full_body") }).optional().describe("Put the picture on this element as a reference view"),
  startPod: z.boolean().default(false),
});
export type CanvasCompose = z.infer<typeof CanvasCompose>;

export const CanvasImport = z.object({
  id: z.string().max(80).describe("Reference id from the library"),
  depth: z.boolean().default(false).describe("Poses: the depth map instead of the line art"),
  view: z.string().max(20).optional().describe("Costumes with views: front, diag, side, back"),
  attach: z.object({ elementId: z.string(), view: z.enum(REF_VIEWS).default("detail") }).optional(),
});
export type CanvasImport = z.infer<typeof CanvasImport>;

type ResolvedSlot<T extends RefItem> = { item?: T; asset?: Asset; url: string; thumb: string; label: string };
export type CanvasRef = { role: "portrait" | "costume" | "pose" | "extra"; label: string; url: string; thumb: string; refId?: string; assetId?: string };

async function referenceOf<K extends RefKind>(id: string, kind: K, adult: boolean): Promise<Extract<RefItem, { kind: K }>> {
  const item = await getReference(id, adult);
  if (item.kind !== kind) throw new StudioError("validation", `${id} is a ${item.kind}, not a ${kind}`);
  return item as Extract<RefItem, { kind: K }>;
}

async function projectPicture(projectId: string, assetId: string): Promise<Asset> {
  const asset = await repo.getAsset(assetId);
  if (asset.kind !== "image" || (asset.projectId !== null && asset.projectId !== projectId)) throw new StudioError("validation", `${assetId} is not a picture of this project`);
  return asset;
}

async function resolveSlot<K extends "portrait" | "costume" | "pose">(projectId: string, kind: K, slot: { id?: string; assetId?: string; view?: string; depth?: boolean } | undefined, adult: boolean): Promise<ResolvedSlot<Extract<RefItem, { kind: K }>> | undefined> {
  if (!slot || (!slot.id && !slot.assetId)) return undefined;
  if (slot.id && slot.assetId) throw new StudioError("validation", `${kind}: give a library id or an uploaded picture, not both`);
  if (slot.assetId) {
    const asset = await projectPicture(projectId, slot.assetId);
    return { asset, url: asset.url, thumb: (asset.meta.previewUrl as string | undefined) ?? asset.url, label: asset.name ?? asset.handle ?? "uploaded picture" };
  }
  const item = await referenceOf(slot.id!, kind, adult);
  const pic = referenceImage(item, { depth: slot.depth, view: slot.view });
  const label = referenceName(item);
  return { item, url: pic.image, thumb: pic.thumb, label };
}

/** The image model a Canvas picture is drawn with: the one asked for, else the project's (Settings → Director). */
export function canvasModel(id: string | undefined, imaging?: { model?: string; backend?: string } | null): ModelEntry {
  const model = id ? findModel(id) : projectImageModel(imaging);
  if (!model || model.kind !== "image") throw new StudioError("validation", `${id} is not an image model (list_models)`);
  return model;
}

export async function composeCharacter(projectId: string, input: CanvasCompose, actor: Actor): Promise<{ job: Job; runner: string; painters: painter.RunnerSummary; prompt: string; refs: CanvasRef[]; model: string; warnings: string[] }> {
  await repo.getProject(projectId);
  const adult = await adultAllowed(actor);
  const portrait = await resolveSlot(projectId, "portrait", input.portrait, adult);
  const costume = await resolveSlot(projectId, "costume", input.costume, adult);
  const pose = await resolveSlot(projectId, "pose", input.pose, adult);
  const extras = await Promise.all(input.extras.map(async (e) => ({ asset: await projectPicture(projectId, e.assetId), name: e.name })));
  if (!portrait && !costume && !pose && !extras.length) throw new StudioError("validation", "pick at least one reference: a portrait, a costume, a pose or a picture");
  const model = canvasModel(input.model, (await repo.getProject(projectId)).imaging);
  const library = input.loras.length ? await repo.getLoras(input.loras.map((r) => r.id)) : new Map();
  const loras = input.loras.map((r) => {
    const l = library.get(r.id);
    if (!l) throw new StudioError("not_found", `no LoRA ${r.id} in the library`);
    return { ...l, strength: r.strength ?? l.recommended.strength ?? l.defaultStrength };
  });
  if (loras.length && model.runtime !== "pod") throw new StudioError("validation", `${model.label} takes no LoRAs; pick a model on the GPU pod`);
  for (const l of loras) {
    if (l.baseModel !== model.family) throw new StudioError("validation", `${l.name} is trained for ${l.baseModel}, not ${model.label} (${model.family})`);
  }
  /* LoRAs made for adult content: only for a user who unlocked 18+, and only on library pictures (an upload may be a real person) */
  const adultLora = loras.find((l) => l.adult);
  if (adultLora && !adult) throw new StudioError("forbidden", `${adultLora.name} is 18+: the user shows 18+ references on the Canvas page first (web only)`, { adult: false });
  if (adultLora) {
    /* a project picture only when the Studio drew it from library or Studio pictures, traced back to the first one */
    const upload = await firstUploadIn(projectId, [portrait?.asset?.url, costume?.asset?.url, pose?.asset?.url, ...extras.map((e) => e.asset.url)]);
    if (upload) throw new StudioError("validation", `${adultLora.name} draws only from the library's pictures (AI-generated adults) and pictures the Studio drew from them: ${upload} is, or was drawn from, an uploaded or imported picture — it may be a real person; remove it`);
  }
  /* Qwen-Image-Edit 2509's graph has fixed slots: portrait, costume, pose (or person + pose) */
  if (model.poseRecipe) {
    if (!pose) throw new StudioError("validation", `${model.label} draws a pose: pick a pose, and a portrait and/or a costume`);
    if (!portrait && !costume) throw new StudioError("validation", `${model.label} needs a portrait or a costume next to the pose`);
    if (extras.length) throw new StudioError("validation", `${model.label} takes only a portrait, a costume and a pose; remove the extra pictures`);
  }
  const maxRefs = model.maxRefs ?? CANVAS_MAX_REFS;
  const count = [portrait, costume, pose].filter(Boolean).length + extras.length;
  if (count > maxRefs) throw new StudioError("validation", `${model.label} takes at most ${maxRefs} pictures per call; this recipe has ${count}`);
  /* An uploaded face may be a real person: never with 18+ references (the galleries forbid sexual or impersonating use of real people). */
  if (portrait?.asset && [costume?.item, pose?.item].some((x) => x?.nsfw)) {
    throw new StudioError("validation", "18+ references cannot be combined with an uploaded face: it may be a real person. Use a library portrait (AI-generated adults) or another reference.");
  }
  /* CharaDB's terms: its outfits are never put on a real person. An uploaded face may be one. */
  if ((costume?.item as RefCostume | undefined)?.source === "charadb" && portrait?.asset) {
    throw new StudioError("validation", "CharaDB outfits cannot be put on an uploaded photo: its author forbids depicting real people. Use a library portrait, or another costume source.");
  }
  if (input.attach) {
    const el = await repo.getElement(input.attach.elementId);
    if (el.projectId !== projectId) throw new StudioError("validation", "attach to an element of this project");
  }

  const recipe: CanvasPromptRecipe = {
    portrait: portrait && (portrait.item ? { item: portrait.item as RefPortrait } : { upload: { name: portrait.label } }),
    costume: costume && (costume.item ? { item: costume.item as RefCostume } : { upload: { name: costume.label } }),
    pose: pose && (pose.item ? { item: pose.item as RefPose, depth: input.pose?.depth, mirror: input.pose?.mirror } : { upload: { name: pose.label }, mirror: input.pose?.mirror }),
    extras: extras.map((e) => ({ name: e.name || e.asset.name || "" })),
    style: input.style,
    note: input.note,
    refStyle: model.refStyle,
  };
  const ADULTS = "画面中的人物均为成年人。";
  const typed = input.prompt?.trim();
  /* the adult line stays even in a prompt the user wrote themselves, whenever an adult LoRA is on */
  const prompt = typed ? (adultLora && !typed.includes(ADULTS) ? `${typed}\n${ADULTS}` : typed) : buildCanvasPrompt(recipe);
  const refs: CanvasRef[] = [
    ...(portrait ? [{ role: "portrait" as const, label: portrait.label, url: portrait.url, thumb: portrait.thumb, ...(portrait.item ? { refId: portrait.item.id } : { assetId: portrait.asset!.id }) }] : []),
    ...(costume ? [{ role: "costume" as const, label: costume.label, url: costume.url, thumb: costume.thumb, ...(costume.item ? { refId: costume.item.id } : { assetId: costume.asset!.id }) }] : []),
    ...(pose ? [{ role: "pose" as const, label: pose.label, url: pose.url, thumb: pose.thumb, ...(pose.item ? { refId: pose.item.id } : { assetId: pose.asset!.id }) }] : []),
    ...extras.map((e) => ({ role: "extra" as const, label: e.name || e.asset.name || "picture", url: e.asset.url, thumb: (e.asset.meta.previewUrl as string | undefined) ?? e.asset.url, assetId: e.asset.id })),
  ];
  const label = `canvas · ${refs.filter((r) => r.role !== "extra").map((r) => r.label).join(" + ") || "pictures"}`.slice(0, 80);
  const mirror = pose && input.pose?.mirror ? [refs.findIndex((r) => r.role === "pose")] : [];
  const resolved = model.runtime === "pod" ? resolveParams(model, { loras }) : undefined;
  const params = resolved ? {
    ...resolved.params, ...(input.seed !== undefined ? { seed: input.seed } : {}),
    ...(loras.length ? { loras: loras.map((l) => ({ file: l.filename, strength: l.strength, name: l.name, ...(l.hfUrl ? { hf_url: l.hfUrl } : {}) })) } : {}),
  } : model.apiModel ? {
    /* the pose gallery's 百炼 request: the model name, prompt_extend, a negative prompt (watermark is always off) */
    api_model: model.apiModel,
    ...(model.options?.includes("prompt_extend") ? { prompt_extend: input.promptExtend } : {}),
    ...(model.options?.includes("negative_prompt") && input.negativePrompt?.trim() ? { negative_prompt: input.negativePrompt.trim() } : {}),
  } : undefined;
  /* a model whose canvas follows a picture (2509: the pose) is delivered at that shape, not cropped to the one picked */
  const size = model.canvasSize ?? input.size;
  const r = await imaging.submitImage(projectId, {
    op: "paint", purpose: "canvas", prompt, refUrls: refs.map((x) => x.url), size, quality: input.quality, targetId: input.attach?.elementId ?? projectId,
    attach: input.attach ? { elementRef: { elementId: input.attach.elementId, view: input.attach.view } } : undefined,
    model: model.id, backend: model.backend, ...(params ? { params } : {}), ...(mirror.length ? { mirrorRefs: mirror } : {}),
    label, canvas: { refs, style: input.style, note: input.note, size, depth: input.pose?.depth ?? false, ...(mirror.length ? { mirror: true } : {}), costumeView: input.costume?.view, promptEdited: !!input.prompt?.trim(), model: model.id, ...(loras.length ? { loras: loras.map((l) => ({ id: l.id, name: l.name, strength: l.strength })) } : {}), ...(model.apiModel ? { promptExtend: input.promptExtend, ...(input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}) } : {}) },
  }, actor, { startPod: input.startPod });
  return { ...r, prompt, refs, model: model.id, warnings: resolved?.warnings ?? [] };
}

/**
 * compose_character for the director (MCP): only with Agent use Canvas on for the project (Settings →
 * Director, web only), and with the project's model and its LoRAs — the user's choice, not the agent's —
 * or, beside a model on the GPU pod, Qwen-Image-Edit 2509 (Canvas's pose recipe, on the same pod).
 */
export async function agentComposeCharacter(projectId: string, input: Omit<CanvasCompose, "loras">, actor: Actor): ReturnType<typeof composeCharacter> {
  const imaging = (await repo.getProject(projectId)).imaging;
  if (!imaging?.agentCanvas) {
    throw new StudioError("forbidden", "Agent use Canvas is off for this project: the user switches it on in Settings → Director (web only). Draw the character with generate_element_sheet instead.", { agentCanvas: false });
  }
  const own = projectImageModel(imaging);
  const picked = input.model ? findModel(input.model) : own;
  if (!picked || picked.kind !== "image") throw new StudioError("validation", `${input.model} is not an image model (list_models)`);
  if (picked.id !== own.id && !(picked.poseRecipe && own.runtime === "pod")) {
    throw new StudioError("forbidden", `this project's pictures are drawn with ${own.label} (Settings → Director, the user's choice): leave model out${own.runtime === "pod" ? ", or pick qwen-image-edit-2509 to compose a pose with a portrait and/or a costume" : ""}`);
  }
  return composeCharacter(projectId, { ...input, model: picked.id, loras: picked.id === own.id ? imaging.loras ?? [] : [] }, actor);
}

/** Bring one reference picture into the project (a single fetch from its gallery), optionally onto an element. */
export async function importReference(projectId: string, input: CanvasImport, actor: Actor): Promise<{ asset: Asset }> {
  await repo.getProject(projectId);
  const item = await getReference(input.id, await adultAllowed(actor));
  if (input.attach) {
    const el = await repo.getElement(input.attach.elementId);
    if (el.projectId !== projectId) throw new StudioError("validation", "attach to an element of this project");
  }
  const pic = referenceImage(item, { depth: input.depth, view: input.view });
  const name = referenceName(item);
  const asset = await importImageFromUrl(projectId, pic.image, actor, { label: `ref · ${name}`.slice(0, 80), reference: { id: item.id, kind: item.kind, depth: input.depth || undefined, view: input.view } });
  if (input.attach) {
    const el = await repo.getElement(input.attach.elementId);
    await repo.updateElement(el.id, { refAssetIds: [...el.refAssetIds.filter((x) => x !== asset.id), asset.id].slice(-6), refViews: { [asset.id]: input.attach.view } });
  }
  return { asset };
}
