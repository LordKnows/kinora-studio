import { route } from "@/api/http";
import { getVoiceJob } from "@/studio/voice-pod";

/* One voice job; ?wait=N (seconds, at most 60) keeps asking the pod until its takes are back. */
export const GET = route(["web", "mcp"], async (req, { params }) => {
  const wait = Number(new URL(req.url).searchParams.get("wait") ?? "0") || 0;
  return { voiceJob: await getVoiceJob(params.id!, params.jobId!, { wait: Math.min(Math.max(wait, 0), 60) }) };
});
