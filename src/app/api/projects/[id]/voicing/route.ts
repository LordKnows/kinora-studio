import { z } from "zod";

import { body, route } from "@/api/http";
import { setVoicing, VOICE_API_MODELS, voicingStatus } from "@/studio/voice-api";

/* A project's voice generation through the voice API (TokenSail): on or off, the TTS model, the
   character budget. Web only: an agent cannot turn on its own voice budget or pick the model. */
export const GET = route(["web", "mcp"], async (_req, { params }) => voicingStatus(params.id!));

export const PUT = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({
    enabled: z.boolean(),
    model: z.enum(VOICE_API_MODELS.map((m) => m.id) as [string, ...string[]]).optional(),
    maxChars: z.number().int().min(100).max(10_000_000).optional(),
    resetUsed: z.boolean().optional(),
  }));
  return setVoicing(params.id!, input, actor);
});
