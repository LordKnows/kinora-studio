import { z } from "zod";

import { body, route } from "@/api/http";
import { patchShot, removeShot } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ShotPatch } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const shot = await repo.getShot(params.id!);
  return { shot, takes: await repo.listShotTakes(params.id!) };
});

export const PATCH = route(["web", "mcp"], async (req, { params }) => {
  const patch = await body(req, ShotPatch.extend({ heroAssetId: z.string().nullable().optional(), endAssetId: z.string().nullable().optional() }));
  return { shot: await patchShot(params.id!, patch) };
});

export const DELETE = route(["web"], async (_req, { params }) => {
  await removeShot(params.id!);
  return { ok: true };
});
