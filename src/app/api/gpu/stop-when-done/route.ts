import { z } from "zod";

import { body, route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* "Stop the GPU when everything has rendered", on or off. Web only: an agent does not decide when the pod stops. */
export const POST = route(["web"], async (req) => {
  const { enabled } = await body(req, z.object({ enabled: z.boolean() }));
  return gpu.setStopWhenDone(enabled);
});
