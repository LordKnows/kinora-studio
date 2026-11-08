import { z } from "zod";

import { body, noStore, route } from "@/api/http";
import { NextResponse } from "next/server";
import { checkPainterToken, claim } from "@/studio/painter";
import { PainterInfo } from "@/studio/schemas";

/* A painter's heartbeat: what it is and can do now, what it is drawing; the
   answer hands it jobs and commands. Token auth (PAINTER_TOKEN). Access
   bypass: /api/painter/*. */
export const POST = route("public", async (req) => {
  checkPainterToken(req);
  const input = await body(req, z.object({ painterId: z.string().min(1).max(80), name: z.string().max(80).default(""), want: z.number().int().min(0).max(16).default(1), info: PainterInfo }));
  return NextResponse.json(await claim({ ...input, info: input.info as Parameters<typeof claim>[0]["info"] }), noStore);
});
