import { z } from "zod";

import { body, route } from "@/api/http";
import { POSE_PICTURES } from "@/studio/canvas-prompt";
import { deleteMyReference, MY_TAGS_MAX, updateMyReference } from "@/studio/references";

/* One of the user's own pictures: rename, retag, say what a pose picture is; or take it out of the library. */

export const PATCH = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ name: z.string().max(60).optional(), tags: z.array(z.string().max(30)).max(MY_TAGS_MAX).optional(), picture: z.enum(POSE_PICTURES).optional() }));
  return { item: await updateMyReference(actor, params.id!, input) };
});

export const DELETE = route(["web"], async (_req, { params, actor }) => {
  await deleteMyReference(actor, params.id!);
  return { ok: true };
});
