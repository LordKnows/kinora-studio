import { NextResponse } from "next/server";
import { errorResponse } from "@/api/http";
import { mapRunPodStatus, verifyHookUrl } from "@/studio/backends/runpod";
import { config } from "@/studio/config";
import * as repo from "@/studio/repo";
import { applyVoiceJobStatus } from "@/studio/voice-pod";

/* The GPU pod's job server posts a finished voice job here (signed URL, as for takes and exports). */
export async function POST(req: Request): Promise<Response> {
  try {
    const id = await verifyHookUrl(new URL(req.url), config.runpod().webhookSecret);
    const job = (await req.json()) as Parameters<typeof mapRunPodStatus>[0];
    const updated = await applyVoiceJobStatus(await repo.getVoiceJob(id), mapRunPodStatus(job));
    return NextResponse.json({ ok: true, status: updated.status });
  } catch (caught) {
    return errorResponse(caught);
  }
}
