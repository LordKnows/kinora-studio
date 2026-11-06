import { z } from "zod";

import { body, route } from "@/api/http";
import { autopilotSummary, grantAutopilot, revokeAutopilot } from "@/studio/craft";
import * as repo from "@/studio/repo";

/* The spend envelope. Granting and revoking are web-only, like the two
   approvals: an agent cannot hand itself a budget. */
export const GET = route(["web", "mcp"], async (_req, { params }) => autopilotSummary(await repo.getProject(params.id!)));

export const POST = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ envelopeUsd: z.number().min(0.01).max(100000), hours: z.number().min(0.5).max(168).optional(), note: z.string().max(300).optional() }));
  return autopilotSummary(await grantAutopilot(params.id!, input, actor));
});

export const DELETE = route(["web"], async (_req, { params, actor }) => autopilotSummary(await revokeAutopilot(params.id!, actor)));
