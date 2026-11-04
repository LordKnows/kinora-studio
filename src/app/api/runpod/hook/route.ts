import { NextResponse } from "next/server";

import { errorResponse } from "@/api/http";
import { mapRunPodStatus, verifyHookUrl } from "@/studio/backends/runpod";
import { config } from "@/studio/config";
import { applyTakeStatus } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";

/* RunPod posts the job here when it finishes. The URL carries an HMAC over the
   take id; the body is RunPod's job object. Answer 200 or RunPod retries. */
export async function POST(req: Request): Promise<Response> {
  try {
    const takeId = await verifyHookUrl(new URL(req.url), config.runpod().webhookSecret);
    const job = (await req.json()) as Parameters<typeof mapRunPodStatus>[0];
    const take = await repo.getTake(takeId);
    if (take.requestId && job.id && take.requestId !== job.id) {
      return NextResponse.json({ ok: true, ignored: "stale job id" });
    }
    const updated = await applyTakeStatus(take, mapRunPodStatus(job));
    return NextResponse.json({ ok: true, status: updated.status });
  } catch (caught) {
    return errorResponse(caught);
  }
}
