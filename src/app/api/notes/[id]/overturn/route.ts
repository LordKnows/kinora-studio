import { z } from "zod";

import { body, route } from "@/api/http";
import { overturnDecision } from "@/studio/craft";

/* The user overturns one of the director's decisions. Web only. */
export const POST = route(["web"], async (req, { params, actor }) => {
  const { reason } = await body(req, z.object({ reason: z.string().max(300).default("") }));
  return { decision: await overturnDecision(params.id!, reason, actor) };
});
