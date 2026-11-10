import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { LoraPatch } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ lora: await repo.getLora(params.id!) }));

export const PATCH = route(["web", "mcp"], async (req, { params }) => {
  const patch = await body(req, LoraPatch.extend({ hfUrl: z.string().url().nullable().optional(), stepsHint: z.number().int().min(1).max(60).nullable().optional() }));
  return { lora: await repo.updateLora(params.id!, patch) };
});

export const DELETE = route(["web"], async (_req, { params }) => {
  await repo.getLora(params.id!);
  await repo.deleteLora(params.id!);
  return { ok: true };
});
