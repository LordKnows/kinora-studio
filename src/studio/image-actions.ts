import { z } from "zod";

import * as imaging from "./imaging";
import { REF_VIEWS } from "./schemas";
import type { Actor } from "./types";

/* One shape for every image action, shared by the web route and the MCP
   tools, so the Board's buttons and the director call the same code. */

const Box = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) });
const Quality = z.enum(["low", "medium", "high"]).optional();
export const ImageAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("element_sheet"), elementId: z.string(), views: z.array(z.enum(REF_VIEWS)).max(7).default([]), quality: Quality, startPod: z.boolean().default(false) }),
  z.object({ action: z.literal("element_view"), elementId: z.string(), view: z.enum(REF_VIEWS), quality: Quality, startPod: z.boolean().default(false) }),
  z.object({ action: z.literal("shot_frame"), shotId: z.string(), which: z.enum(["first", "last"]), method: z.enum(["new", "edit_from_last", "edit_from_previous", "edit_anchor", "edit_picture", "crop_from_first", "crop_from_last"]).optional(), baseAssetId: z.string().optional(), zoom: z.number().min(1.05).max(1.6).optional(), instruction: z.string().max(600).optional(), quality: Quality, startPod: z.boolean().default(false) }),
  z.object({ action: z.literal("edit"), assetId: z.string(), instruction: z.string().min(5).max(800), region: Box.optional(), refAssetIds: z.array(z.string()).max(4).optional(), heroOf: z.string().optional(), endOf: z.string().optional(), purpose: z.enum(["edit", "remake_key"]).optional(), quality: Quality, startPod: z.boolean().default(false) }),
  z.object({ action: z.literal("extract"), takeId: z.string(), frame: z.number().int().min(0).max(400), startPod: z.boolean().default(false) }),
  z.object({ action: z.literal("style_frame"), quality: Quality, startPod: z.boolean().default(false) }),
]);
export type ImageAction = z.infer<typeof ImageAction>;

export async function runImageAction(projectId: string, a: ImageAction, actor: Actor): Promise<unknown> {
  switch (a.action) {
    case "element_sheet":
      return imaging.generateElementSheet(a.elementId, a.views, actor, a);
    case "element_view":
      return imaging.generateElementView(a.elementId, a.view, actor, a);
    case "shot_frame":
      return imaging.generateShotFrame(a.shotId, a.which, actor, a);
    case "edit":
      return imaging.editFrame(a.assetId, { instruction: a.instruction, region: a.region, refAssetIds: a.refAssetIds, purpose: a.purpose, quality: a.quality, startPod: a.startPod, attach: a.heroOf || a.endOf ? { heroOf: a.heroOf, endOf: a.endOf } : undefined }, actor);
    case "extract":
      return imaging.extractTakeFrame(a.takeId, a.frame, actor, a);
    case "style_frame":
      return imaging.generateStyleFrame(projectId, actor, a);
  }
}
