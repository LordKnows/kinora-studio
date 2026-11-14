import { z } from "zod";

import { body, route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* Web only: the pod bills by the hour, so a person starts it. The director can stop it (gpu_stop), not start it. */
export const POST = route(["web"], async (req, { actor }) => {
  const { confirm } = await body(req, z.object({ confirm: z.boolean().default(false) }));
  return gpu.startGpu(actor, confirm);
});
