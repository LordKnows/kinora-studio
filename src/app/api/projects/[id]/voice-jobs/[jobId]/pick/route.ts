import { z } from "zod";

import { body, route } from "@/api/http";
import { MAX_TAKES, pickVoiceTake } from "@/studio/voice-pod";

/* Keep the take the user chose: an audio asset; optionally a reference on the card and the line's audio. */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ take: z.number().int().min(1).max(MAX_TAKES), addAsReference: z.boolean().optional(), attachToLine: z.boolean().optional() }));
  return pickVoiceTake(params.id!, params.jobId!, input, actor);
});
