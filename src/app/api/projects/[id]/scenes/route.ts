import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  const input = await body(req, z.object({ slug: z.string().min(1).max(60), summary: z.string().max(400).default(""), location: z.string().optional() }));
  const scene = await repo.createScene(params.id!, input);
  await repo.setShotlistApproval(params.id!, "draft");
  return { scene };
});
