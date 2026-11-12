import { route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import * as gpu from "@/studio/gpu";

/* Web only, admins: terminating deletes the pod's container disk, for everyone. */
export const POST = route(["web"], async (_req, { actor }) => {
  requireAdmin(actor, "terminating the GPU pod");
  return gpu.terminateGpu();
});
