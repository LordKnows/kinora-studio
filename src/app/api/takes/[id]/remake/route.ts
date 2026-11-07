import { z } from "zod";

import { body, route } from "@/api/http";
import { remakeTake } from "@/studio/remake";

export const RemakeInput = z.object({
  mode: z.enum(["edit", "swap"]),
  keyframes: z.array(z.object({ assetId: z.string(), frame: z.number().int().min(0).max(344).optional() })).min(1).max(4),
  changes: z.array(z.object({ subject: z.string().min(3).max(300), target: z.string().min(3).max(600), fate: z.enum(["changed", "removed"]).optional() })).max(6).optional(),
  prompt: z.string().max(8000).optional(),
  shortEdge: z.union([z.literal(480), z.literal(736)]).optional(),
  seed: z.number().int().min(0).optional(),
  confirm: z.boolean().default(false),
});

/* Viggle Remake of a finished take: a new take of the same shot. */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => remakeTake(params.id!, await body(req, RemakeInput), actor));
