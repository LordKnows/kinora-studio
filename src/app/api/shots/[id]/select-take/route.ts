import { z } from "zod";

import { body, route } from "@/api/http";
import { selectTake } from "@/studio/orchestrator";

export const POST = route(["web", "mcp"], async (req, { params }) => {
  const { takeId } = await body(req, z.object({ takeId: z.string().nullable() }));
  return { shot: await selectTake(params.id!, takeId) };
});
