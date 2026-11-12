import { route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import { forgetPainter } from "@/studio/painter";

/* Admins: forget an offline painter (it reappears if it polls again). */
export const DELETE = route(["web"], async (_req, { params, actor }) => {
  requireAdmin(actor, "forgetting a painter");
  await forgetPainter(params.id!);
  return { ok: true };
});
