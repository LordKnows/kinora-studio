import { route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import { stopPainterPod } from "@/studio/painter-pod";

/* Admins: terminate the painter pod now (it is also terminated by itself after idling; the volume keeps the login). */
export const POST = route(["web"], async (_req, { actor }) => {
  requireAdmin(actor, "terminating the painter pod");
  return stopPainterPod("terminated on the Machine page");
});
