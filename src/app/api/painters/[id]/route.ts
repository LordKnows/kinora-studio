import { route } from "@/api/http";
import { forgetPainter } from "@/studio/painter";

/* Forget an offline painter (it reappears if it polls again). */
export const DELETE = route(["web"], async (_req, { params }) => {
  await forgetPainter(params.id!);
  return { ok: true };
});
