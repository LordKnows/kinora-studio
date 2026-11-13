import { z } from "zod";

import { body, route } from "@/api/http";
import { listVoiceJobs, MAX_TAKES, speakLine } from "@/studio/voice-pod";

/* Voice jobs on the GPU pod (Qwen3-TTS VoiceDesign): a shot line spoken several times, for the user to pick from. */
export const GET = route(["web", "mcp"], async (req, { params }) => {
  const shotId = new URL(req.url).searchParams.get("shotId") ?? undefined;
  return { voiceJobs: await listVoiceJobs(params.id!, { shotId }) };
});

export const POST = route(["web", "mcp"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ shotId: z.string().min(1).max(40), line: z.number().int().min(0).max(7), takes: z.number().int().min(1).max(MAX_TAKES).optional() }));
  return { voiceJob: await speakLine(params.id!, input.shotId, input.line, { takes: input.takes }, actor) };
});
