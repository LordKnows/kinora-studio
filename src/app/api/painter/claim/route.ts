import { z } from "zod";

import { body, noStore, route } from "@/api/http";
import { NextResponse } from "next/server";
import { checkPainterToken, claim } from "@/studio/painter";

/* A painter's heartbeat: what it is and can do now, what it is drawing; the
   answer hands it jobs and commands. Token auth (PAINTER_TOKEN). Access
   bypass: /api/painter/*. */
const Info = z.object({
  version: z.string().max(40).optional(),
  host: z.string().max(120).optional(),
  backends: z.array(z.enum(["codex", "api"])).max(2).default([]),
  ops: z.array(z.enum(["paint", "crop", "extract"])).max(3).default(["paint", "crop", "extract"]),
  slots: z.number().int().min(0).max(16).optional(),
  running: z.array(z.string().max(80)).max(50).default([]),
  onPod: z.boolean().optional(),
  codex: z.record(z.string(), z.unknown()).optional(),
  login: z.object({ state: z.string().max(20), url: z.string().max(400).optional(), code: z.string().max(40).optional(), lines: z.array(z.string().max(400)).max(20).optional(), error: z.string().max(400).optional() }).optional(),
  lastError: z.string().max(600).optional(),
});

export const POST = route("public", async (req) => {
  checkPainterToken(req);
  const input = await body(req, z.object({ painterId: z.string().min(1).max(80), name: z.string().max(80).default(""), want: z.number().int().min(0).max(16).default(1), info: Info }));
  return NextResponse.json(await claim({ ...input, info: input.info as Parameters<typeof claim>[0]["info"] }), noStore);
});
