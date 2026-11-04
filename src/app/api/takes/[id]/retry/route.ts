import { z } from "zod";

import { body, route } from "@/api/http";
import { retryTake } from "@/studio/orchestrator";

export const POST = route(["web", "mcp"], async (req, { params, actor }) => {
  const { confirm } = await body(req, z.object({ confirm: z.boolean().default(false) }));
  return { take: await retryTake(params.id!, actor, confirm) };
});
