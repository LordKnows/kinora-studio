import { z } from "zod";

import { body, route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import * as gpu from "@/studio/gpu";

/* Web only, admins: take over a pod created in the RunPod console. */
export const POST = route(["web"], async (req, { actor }) => {
  requireAdmin(actor, "adopting a GPU pod");
  const { podId } = await body(req, z.object({ podId: z.string().min(6).max(64) }));
  return gpu.adoptPod(podId.trim());
});
