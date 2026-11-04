import { NextResponse } from "next/server";

import { errorResponse } from "@/api/http";
import { StudioError } from "@/studio/errors";
import { sweep } from "@/studio/orchestrator";

/* Called by a Cloudflare Cron Trigger (or any scheduler) with the shared
   secret. Polls every take, image job and export still in flight. */
async function run(req: Request): Promise<Response> {
  try {
    const secret = process.env.CRON_SECRET;
    const given = req.headers.get("x-cron-secret") ?? new URL(req.url).searchParams.get("secret");
    if (secret && given !== secret) throw new StudioError("unauthorized", "bad cron secret");
    return NextResponse.json(await sweep());
  } catch (caught) {
    return errorResponse(caught);
  }
}

export const GET = run;
export const POST = run;
