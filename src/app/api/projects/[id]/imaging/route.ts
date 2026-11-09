import { z } from "zod";

import { body, route } from "@/api/http";
import { imagingStatus, setImaging } from "@/studio/imaging";
import { AGENT_IMAGE_MODELS } from "@/studio/models";
import * as repo from "@/studio/repo";
import { LoraRef } from "@/studio/schemas";

/* A project's image generation: on or off, the model it draws with, its LoRAs, whether the agent may
   use Canvas, the quota. Web only: an agent cannot turn on its own image budget or pick the model. */
export const GET = route(["web", "mcp"], async (_req, { params }) => imagingStatus(await repo.getProject(params.id!)));

export const PUT = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ enabled: z.boolean(), model: z.enum(AGENT_IMAGE_MODELS.map((m) => m.id) as [string, ...string[]]).optional(), backend: z.enum(["codex", "api"]).optional(), loras: z.array(LoraRef).max(4).optional(), agentCanvas: z.boolean().optional(), maxImages: z.number().int().min(1).max(2000).optional(), quality: z.enum(["low", "medium", "high"]).optional(), selfCheck: z.boolean().optional(), autoRedraws: z.number().int().min(0).max(2).optional(), clearStop: z.boolean().optional() }));
  return imagingStatus(await setImaging(params.id!, input, actor));
});
