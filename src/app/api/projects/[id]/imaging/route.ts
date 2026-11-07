import { z } from "zod";

import { body, route } from "@/api/http";
import { imagingSummary, setImaging } from "@/studio/imaging";
import * as repo from "@/studio/repo";

/* The GPT Image switch of a project. Web only: an agent cannot turn on its own image budget. */
export const GET = route(["web", "mcp"], async (_req, { params }) => imagingSummary(await repo.getProject(params.id!)));

export const PUT = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ enabled: z.boolean(), backend: z.enum(["codex", "api"]).optional(), maxImages: z.number().int().min(1).max(2000).optional(), quality: z.enum(["low", "medium", "high"]).optional(), selfCheck: z.boolean().optional(), autoRedraws: z.number().int().min(0).max(2).optional(), clearStop: z.boolean().optional() }));
  return imagingSummary(await setImaging(params.id!, input, actor));
});
