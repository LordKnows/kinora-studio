import { z } from "zod";

import { body, route } from "@/api/http";
import { delegationSummary, setDelegation } from "@/studio/craft";
import * as repo from "@/studio/repo";

/* Delegated approval of the two checkpoints. Switched on the web only: an
   agent cannot hand itself the user's approvals. */
export const GET = route(["web", "mcp"], async (_req, { params }) => delegationSummary(await repo.getProject(params.id!)));

export const PUT = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ script: z.boolean(), shotlist: z.boolean() }));
  return delegationSummary(await setDelegation(params.id!, input, actor));
});
