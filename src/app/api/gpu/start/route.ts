import { z } from "zod";

import { body, route } from "@/api/http";
import * as gpu from "@/studio/gpu";

export const POST = route(["web", "mcp"], async (req, { actor }) => {
  const { confirm, gpuTypeId, replace } = await body(req, z.object({ confirm: z.boolean().default(false), gpuTypeId: z.string().min(1).max(80).optional(), replace: z.boolean().default(false) }));
  return gpu.startGpu(actor, confirm, { gpuTypeId, replace: replace && actor.via === "web" });
});
