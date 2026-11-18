import { z } from "zod";

import { body, route } from "@/api/http";
import { addScene } from "@/studio/orchestrator";
import { ShotInput } from "@/studio/schemas";

/* A new scene, last on the board; ?position=2 puts it second (1 = first). Its slug must be new to the project.
   `shots` puts shots in it at once; nothing else in the shotlist is touched. */
export const POST = route(["web", "mcp"], async (req, { params }) => {
  const input = await body(req, z.object({ slug: z.string().trim().min(1).max(60), summary: z.string().max(400).default(""), location: z.string().optional(), shots: z.array(ShotInput).max(40).optional() }));
  const position = Number(new URL(req.url).searchParams.get("position"));
  return { scene: await addScene(params.id!, input, Number.isFinite(position) && position >= 1 ? position : undefined) };
});
