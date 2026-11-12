import { route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import * as gpu from "@/studio/gpu";

/* Web only, admins: put the studio's boot command and env on the current pod and restart it. */
export const POST = route(["web"], async (_req, { actor }) => {
  requireAdmin(actor, "repairing the GPU pod");
  return gpu.repairGpu();
});
