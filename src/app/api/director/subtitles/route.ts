import { z } from "zod";

import { body, route } from "@/api/http";
import * as director from "@/director";

/* Reading-time check for subtitle lines; places unplaced lines; returns the SRT. */
export const POST = route(["web", "mcp"], async (req) => {
  const input = await body(req, z.object({
    lines: z.array(z.object({ id: z.string(), text: z.string(), t0: z.number().optional(), t1: z.number().optional(), language: z.string().optional(), speechS: z.number().optional() })),
    startS: z.number().min(0).default(0),
    gapS: z.number().min(0).default(0.3),
  }));
  const placed = director.placeLines(input.lines as director.Line[], input.startS, input.gapS);
  return { issues: director.checkLines(placed), lines: placed, srt: director.toSrt(placed) };
});
