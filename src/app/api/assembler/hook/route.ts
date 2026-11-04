import { NextResponse } from "next/server";

import { errorResponse } from "@/api/http";
import { mapRunPodStatus, verifyHookUrl } from "@/studio/backends/runpod";
import { config } from "@/studio/config";
import { applyExportStatus } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";

export async function POST(req: Request): Promise<Response> {
  try {
    const exportId = await verifyHookUrl(new URL(req.url), config.runpod().webhookSecret);
    const job = (await req.json()) as Parameters<typeof mapRunPodStatus>[0];
    const row = await repo.getExport(exportId);
    const updated = await applyExportStatus(row, mapRunPodStatus(job));
    return NextResponse.json({ ok: true, status: updated.status });
  } catch (caught) {
    return errorResponse(caught);
  }
}
