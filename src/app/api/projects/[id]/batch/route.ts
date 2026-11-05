import { z } from "zod";

import { body, route } from "@/api/http";
import { planProjectBatch } from "@/studio/orchestrator";

/* The render plan: order, passes, one estimate against the cap. */
export const POST = route(["web", "mcp"], async (req, { params }) => {
  const input = await body(req, z.object({ takesPerShot: z.number().int().min(1).max(4).default(1), onlyMissing: z.boolean().default(true) }));
  return planProjectBatch(params.id!, input);
});
