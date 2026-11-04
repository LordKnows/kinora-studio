import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const PATCH = route(["web", "mcp"], async (req, { params }) => {
  const patch = await body(req, z.object({ slug: z.string().min(1).max(60).optional(), summary: z.string().max(400).optional(), location: z.string().nullable().optional() }));
  return { scene: await repo.updateScene(params.id!, patch) };
});

export const DELETE = route(["web"], async (_req, { params }) => {
  const scene = await repo.getScene(params.id!);
  await repo.deleteScene(params.id!);
  await repo.setShotlistApproval(scene.projectId, "draft");
  return { ok: true };
});
