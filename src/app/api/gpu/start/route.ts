import { z } from "zod";

import { body, route } from "@/api/http";
import * as gpu from "@/studio/gpu";

export const POST = route(["web", "mcp"], async (req, { actor }) => {
  const { confirm } = await body(req, z.object({ confirm: z.boolean().default(false) }));
  return gpu.startGpu(actor, confirm);
});
