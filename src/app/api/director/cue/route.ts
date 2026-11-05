import { z } from "zod";

import { body, route } from "@/api/http";
import * as director from "@/director";

/* Beat grid → hit times and per-clip out points that land on the grid. */
const CueMap = z.object({
  sections: z.array(z.object({ id: z.string(), t: z.number().min(0), bpm: z.number().min(20).max(300), beatsPerBar: z.number().int().min(1).max(12).optional(), texture: z.string().optional() })).min(1),
  hits: z.array(z.object({ id: z.string(), section: z.string(), bar: z.number(), beat: z.number(), what: z.string() })).default([]),
  silences: z.array(z.object({ t: z.number(), durationS: z.number(), why: z.string() })).optional(),
});
export const POST = route(["web", "mcp"], async (req) => {
  const input = await body(req, z.object({ cueMap: CueMap, shots: z.array(z.object({ durationS: z.number().positive() })), subdivision: z.number().positive().default(1), startS: z.number().min(0).default(0), minS: z.number().positive().default(2) }));
  return {
    warnings: director.checkCueMap(input.cueMap as director.CueMap, undefined, undefined),
    hits: director.hitTimes(input.cueMap as director.CueMap),
    cuts: director.cutOnBeats(input.cueMap as director.CueMap, input.shots, { subdivision: input.subdivision, startS: input.startS, minS: input.minS }),
  };
});
