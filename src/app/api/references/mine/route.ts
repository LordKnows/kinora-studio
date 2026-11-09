import { z } from "zod";

import { body, noStore, route } from "@/api/http";
import { POSE_PICTURES } from "@/studio/canvas-prompt";
import { addMyReference, listMyReferences, MY_TAGS_MAX } from "@/studio/references";

/* 我的: the signed-in user's own pictures in the Canvas library. GET lists them; POST adds one the browser has
   put in R2 (presign → PUT): a portrait gets its face check (模拟 / 真实), a costume or a pose none. */

export const GET = route(["web", "mcp"], async (_req, { actor }) => Response.json({ items: await listMyReferences(actor) }, noStore));

export const POST = route(["web"], async (req, { actor }) => {
  const input = await body(req, z.object({
    key: z.string().min(1).max(400),
    kind: z.enum(["portrait", "costume", "pose"]),
    name: z.string().max(60).default(""),
    tags: z.array(z.string().max(30)).max(MY_TAGS_MAX).default([]),
    picture: z.enum(POSE_PICTURES).optional(),
  }));
  return { item: await addMyReference(actor, input) };
});
