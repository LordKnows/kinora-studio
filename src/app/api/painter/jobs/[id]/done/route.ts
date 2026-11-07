import { z } from "zod";

import { body, route } from "@/api/http";
import { checkPainterToken, finish } from "@/studio/painter";

/* The painter's answer for a job it holds: the picture's urls (already in R2) or an error. */
export const POST = route("public", async (req, { params }) => {
  checkPainterToken(req);
  const input = await body(req, z.object({ painterId: z.string().min(1).max(80), output: z.record(z.string(), z.unknown()).optional(), error: z.string().max(4000).optional() }));
  const job = await finish(params.id!, input.painterId, input);
  return { status: job.status, assetIds: job.assetIds };
});
