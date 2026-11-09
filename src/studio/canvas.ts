import { z } from "zod";

import { buildCanvasPrompt, CANVAS_MAX_REFS, CANVAS_MAX_REFS_ANY, CANVAS_SIZES, CANVAS_STYLE_IDS, PLACES, POSE_PICTURES, type CanvasPerson, type CanvasPromptRecipe } from "./canvas-prompt";
import { StudioError } from "./errors";
import * as imaging from "./imaging";
import { importImageFromUrl } from "./images";
import * as painter from "./painter";
import { findModel, IMAGE_MODELS, projectImageModel, resolveParams, type ModelEntry } from "./models";
import { firstUploadedFaceIn } from "./provenance";
import { adultAllowed, getReference } from "./references";
import { referenceImage, referenceName, type RefCostume, type RefItem, type RefKind, type RefPortrait, type RefPose } from "./references-model";
import * as repo from "./repo";
import { LoraRef, REF_VIEWS } from "./schemas";
import type { Actor, Asset, Element, Job } from "./types";

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

const CostumeSlot = Slot.extend({ view: z.string().max(20).optional() });
const Character = z.object({ elementId: z.string().max(80) }).describe("A project character instead of a portrait: its front (or full-body) reference is the face, the hair and, without a costume, the outfit");

export const CanvasCompose = z.object({
  portrait: Slot.optional(),
  costume: CostumeSlot.optional(),
  character: Character.optional(),
  name: z.string().max(40).optional().describe("Two people: what the prompt calls person A (else the character's name, or 人物A)"),
  partner: z.object({
    portrait: Slot.optional(),
    costume: CostumeSlot.optional(),
    character: Character.optional(),
    name: z.string().max(40).optional().describe("What the prompt calls person B (else the character's name, or 人物B)"),
  }).optional().describe("Two people: person B — a portrait and/or a costume, or a project character — drawn with person A (portrait / costume / character above) in one two-person pose (list_references system couple, or an uploaded two-person pose)"),
  aIs: z.enum(PLACES).default("left").describe("Two people: which figure of the pose is person A — left, right, front (nearer the camera), back, top or bottom — on the pose picture as drawn (after mirror); the other is person B"),
  pose: Slot.extend({
    depth: z.boolean().default(false).describe("A library pose: its depth map instead of the line art"),
    picture: z.enum(POSE_PICTURES).default("photo").describe("An uploaded pose (assetId): what the picture is — photo (a person: only the pose and framing are taken), mannequin (白模 / line art), depth (a grey depth map)"),
    mirror: z.boolean().default(false).describe("Flip the pose picture left to right (the pose turned the other way)"),
  }).optional(),
  model: z.enum(IMAGE_MODELS.map((m) => m.id) as [string, ...string[]]).optional().describe("Image model (list_models): gpt-image-codex, gpt-image-api, qwen-image-3.0-pro (API, CPU painter pod, up to 3 pictures), or on the GPU pod qwen-image-2.1-turbo, qwen-image-2.1, qwen-image-edit-2509 (pose + portrait and/or costume). Omit for the project's model (Settings → Director)."),
  promptExtend: z.boolean().default(false).describe("Qwen-Image 3.0 Pro: let the vendor rewrite the prompt (prompt_extend; off keeps the composed 图1/图2/图3 roles as written)"),
  negativePrompt: z.string().max(500).optional().describe("Qwen-Image 3.0 Pro: what the picture must not show"),
  extras: z.array(z.object({ assetId: z.string().max(80), name: z.string().max(60).default("") })).max(CANVAS_MAX_REFS_ANY).default([]),
  seed: z.number().int().min(0).max(2 ** 48).optional().describe("Pod models: a fixed seed (else random)"),
  loras: z.array(LoraRef).max(4).default([]).describe("Pod models: LoRAs from the library trained for the model's family (list_models); picking one applies its card's settings (ChatR Omni on Qwen-Image 2.1: 35 steps, CFG 5)"),
  style: z.enum(CANVAS_STYLE_IDS).default("realistic"),
  text: z.string().max(2000).optional().describe("Text to image: what to draw. With no reference picked it is the whole picture (the style, size, model and LoRAs still apply); beside references it is the scene they go into"),
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
export type CanvasRole = "portrait" | "costume" | "character" | "portrait_b" | "costume_b" | "character_b" | "pose" | "extra";
export type CanvasRef = { role: CanvasRole; label: string; url: string; thumb: string; refId?: string; assetId?: string; elementId?: string };

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

/** What a Canvas reference is to the picture (provenance.ts): the faces it keeps, the outfits and the pose it borrows. */
const CANVAS_REF_ROLE: Record<CanvasRole, imaging.RefRole> = { portrait: "face", character: "face", portrait_b: "face", character_b: "face", extra: "face", costume: "outfit", costume_b: "outfit", pose: "pose" };

type ResolvedCharacter = { element: Element; asset: Asset; url: string; thumb: string; label: string };

/** A project character as a person of the picture: its front reference (else full body, three-quarter, the first). */
async function characterOf(projectId: string, elementId: string): Promise<ResolvedCharacter> {
  const element = await repo.getElement(elementId);
  if (element.projectId !== projectId) throw new StudioError("validation", "pick a character of this project");
  const views = element.refViews ?? {};
  const pick = (["front", "full_body", "three_quarter"] as const).map((v) => element.refAssetIds.find((id) => views[id] === v)).find(Boolean) ?? element.refAssetIds[0];
  if (!pick) throw new StudioError("validation", `${element.name} has no reference picture yet: draw its sheet, or pick a portrait`);
  const asset = await repo.getAsset(pick);
  return { element, asset, url: asset.url, thumb: (asset.meta.previewUrl as string | undefined) ?? asset.url, label: element.name };
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
  if (input.character && input.portrait) throw new StudioError("validation", "person A: a character or a portrait, not both");
  if (input.partner?.character && input.partner.portrait) throw new StudioError("validation", "person B: a character or a portrait, not both");
  const portrait = await resolveSlot(projectId, "portrait", input.portrait, adult);
  const costume = await resolveSlot(projectId, "costume", input.costume, adult);
  const character = input.character ? await characterOf(projectId, input.character.elementId) : undefined;
  const partner = input.partner ? {
    portrait: await resolveSlot(projectId, "portrait", input.partner.portrait, adult),
    costume: await resolveSlot(projectId, "costume", input.partner.costume, adult),
    character: input.partner.character ? await characterOf(projectId, input.partner.character.elementId) : undefined,
    name: input.partner.name,
  } : undefined;
  const pose = await resolveSlot(projectId, "pose", input.pose, adult);
  const extras = await Promise.all(input.extras.map(async (e) => ({ asset: await projectPicture(projectId, e.assetId), name: e.name })));
  if (partner && !partner.portrait && !partner.costume && !partner.character) throw new StudioError("validation", "person B needs a portrait, a costume or a character");
  if (partner && !portrait && !costume && !character) throw new StudioError("validation", "person A needs a portrait, a costume or a character");
  const textOnly = !portrait && !costume && !character && !pose && !extras.length;
  if (textOnly && !input.text?.trim() && !input.prompt?.trim()) throw new StudioError("validation", "pick at least one reference (a portrait, a costume, a pose or a picture), or describe the picture (text) to draw it from text alone");
  if (partner && input.attach) throw new StudioError("validation", "a picture of two people is not one character's look: it stays in Pictures (leave attach out)");
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
  /* LoRAs made for adult content: only for a user who unlocked 18+ */
  const adultLora = loras.find((l) => l.adult);
  if (adultLora && !adult) throw new StudioError("forbidden", `${adultLora.name} is 18+: the user shows 18+ references on the Canvas page first (web only)`, { adult: false });
  /* 18+ (a LoRA, or a library reference): every face comes from the library's portraits (AI-generated adults) or a
     picture the Studio drew from them — never an upload, which may be a real person. Uploaded outfits and poses are fine. */
  const nsfw = [portrait?.item, costume?.item, pose?.item, partner?.portrait?.item, partner?.costume?.item].some((x) => x?.nsfw);
  if (adultLora || nsfw) {
    const face = await firstUploadedFaceIn(projectId, [portrait?.asset?.url, character?.url, partner?.portrait?.asset?.url, partner?.character?.url, ...extras.map((e) => e.asset.url)]);
    if (face) {
      throw new StudioError("validation", `${adultLora ? `${adultLora.name} is 18+` : "The recipe holds 18+ references"}: every face must be AI-generated — the library's portraits, or a picture the Studio drew whose faces are AI-generated too. ${face} is an uploaded or imported picture, or keeps a face from one. An uploaded face goes in when its face check finds a 3D render or an illustration of an adult who is no real person (a photograph or anything photorealistic stays out); uploaded outfits, poses and backgrounds are fine.`);
    }
  }
  /* CharaDB's terms: its outfits are never put on a real person — an uploaded face, or a picture drawn from one */
  for (const [who, p] of [["person A", { costume, face: portrait?.asset?.url ?? character?.url }], ["person B", { costume: partner?.costume, face: partner?.portrait?.asset?.url ?? partner?.character?.url }]] as const) {
    if ((p.costume?.item as RefCostume | undefined)?.source !== "charadb" || !p.face) continue;
    if (await firstUploadedFaceIn(projectId, [p.face])) {
      throw new StudioError("validation", `CharaDB outfits cannot be put on an uploaded photo (${partner ? who : "the portrait"}): its author forbids depicting real people. Use a library portrait, or another costume source.`);
    }
  }
  /* Qwen-Image-Edit 2509's graph has fixed slots: portrait, costume, pose (or person + pose) */
  if (model.poseRecipe) {
    if (partner) throw new StudioError("validation", `${model.label} draws one person: for two people pick GPT Image or Qwen-Image 2.1`);
    if (textOnly) throw new StudioError("validation", `${model.label} draws a pose from pictures, not from text alone: pick GPT Image, Qwen-Image 3.0 Pro or Qwen-Image 2.1 for text to image`);
    if (!pose) throw new StudioError("validation", `${model.label} draws a pose: pick a pose, and a portrait and/or a costume`);
    if (!portrait && !character && !costume) throw new StudioError("validation", `${model.label} needs a portrait or a costume next to the pose`);
    if (extras.length) throw new StudioError("validation", `${model.label} takes only a portrait, a costume and a pose; remove the extra pictures`);
  }
  const maxRefs = model.maxRefs ?? CANVAS_MAX_REFS;
  const count = [portrait ?? character, costume, partner?.portrait ?? partner?.character, partner?.costume, pose].filter(Boolean).length + extras.length;
  if (count > maxRefs) throw new StudioError("validation", `${model.label} takes at most ${maxRefs} pictures per call; this recipe has ${count}${partner ? " (a project character's sheet stands for its face and outfit in one picture)" : ""}`);
  if (input.attach) {
    const el = await repo.getElement(input.attach.elementId);
    if (el.projectId !== projectId) throw new StudioError("validation", "attach to an element of this project");
  }

  const person = (p: { portrait?: ResolvedSlot<RefItem>; costume?: ResolvedSlot<RefItem>; character?: ResolvedCharacter }, name?: string): CanvasPerson => ({
    ...(p.portrait ? { portrait: p.portrait.item ? { item: p.portrait.item as RefPortrait } : { upload: { name: p.portrait.label } } } : {}),
    ...(p.costume ? { costume: p.costume.item ? { item: p.costume.item as RefCostume } : { upload: { name: p.costume.label } } } : {}),
    ...(p.character ? { character: { name: p.character.label } } : {}),
    ...(name?.trim() ? { name: name.trim() } : {}),
  });
  const recipe: CanvasPromptRecipe = {
    ...person({ portrait, costume, character }, partner ? input.name : undefined),
    ...(partner ? { partner: person(partner, partner.name), aIs: input.aIs } : {}),
    pose: pose && (pose.item ? { item: pose.item as RefPose, depth: input.pose?.depth, mirror: input.pose?.mirror } : { upload: { name: pose.label }, mirror: input.pose?.mirror, picture: input.pose?.picture }),
    extras: extras.map((e) => ({ name: e.name || e.asset.name || "" })),
    ...(input.text?.trim() ? { text: input.text.trim() } : {}),
    style: input.style,
    note: input.note,
    refStyle: model.refStyle,
  };
  const ADULTS = "画面中的人物均为成年人。";
  const typed = input.prompt?.trim();
  /* the adult line stays even in a prompt the user wrote themselves, whenever an adult LoRA is on */
  const prompt = typed ? (adultLora && !typed.includes(ADULTS) ? `${typed}\n${ADULTS}` : typed) : buildCanvasPrompt(recipe);
  const slotRef = (role: CanvasRole, r: ResolvedSlot<RefItem> | undefined): CanvasRef[] => (r ? [{ role, label: r.label, url: r.url, thumb: r.thumb, ...(r.item ? { refId: r.item.id } : { assetId: r.asset!.id }) }] : []);
  const charRef = (role: CanvasRole, c: ResolvedCharacter | undefined): CanvasRef[] => (c ? [{ role, label: c.label, url: c.url, thumb: c.thumb, assetId: c.asset.id, elementId: c.element.id }] : []);
  /* the order the prompt names them: person A's face, outfit; person B's; the pose; the extras */
  const refs: CanvasRef[] = [
    ...(character ? charRef("character", character) : slotRef("portrait", portrait)),
    ...slotRef("costume", costume),
    ...(partner ? [...(partner.character ? charRef("character_b", partner.character) : slotRef("portrait_b", partner.portrait)), ...slotRef("costume_b", partner.costume)] : []),
    ...slotRef("pose", pose),
    ...extras.map((e) => ({ role: "extra" as const, label: e.name || e.asset.name || "picture", url: e.asset.url, thumb: (e.asset.meta.previewUrl as string | undefined) ?? e.asset.url, assetId: e.asset.id })),
  ];
  const label = `canvas · ${refs.filter((r) => r.role !== "extra").map((r) => r.label).join(" + ") || (input.text?.trim() ? `text: ${input.text.trim()}` : "pictures")}`.slice(0, 80);
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
    op: "paint", purpose: "canvas", prompt, refUrls: refs.map((x) => x.url), refRoles: refs.map((x) => CANVAS_REF_ROLE[x.role]), size, quality: input.quality, targetId: input.attach?.elementId ?? projectId,
    attach: input.attach ? { elementRef: { elementId: input.attach.elementId, view: input.attach.view } } : undefined,
    model: model.id, backend: model.backend, ...(params ? { params } : {}), ...(mirror.length ? { mirrorRefs: mirror } : {}),
    label, canvas: { refs, style: input.style, note: input.note, ...(input.text?.trim() ? { text: input.text.trim() } : {}), size, depth: input.pose?.depth ?? false, ...(partner ? { people: 2, aIs: input.aIs, ...(input.name?.trim() ? { nameA: input.name.trim() } : {}), ...(partner.name?.trim() ? { nameB: partner.name.trim() } : {}) } : {}), ...(pose?.asset && input.pose?.picture && input.pose.picture !== "photo" ? { posePicture: input.pose.picture } : {}), ...(mirror.length ? { mirror: true } : {}), costumeView: input.costume?.view, promptEdited: !!input.prompt?.trim(), model: model.id, ...(loras.length ? { loras: loras.map((l) => ({ id: l.id, name: l.name, strength: l.strength })) } : {}), ...(model.apiModel ? { promptExtend: input.promptExtend, ...(input.negativePrompt?.trim() ? { negativePrompt: input.negativePrompt.trim() } : {}) } : {}) },
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
