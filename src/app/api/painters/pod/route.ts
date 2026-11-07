import { z } from "zod";

import { body, route } from "@/api/http";
import { adoptPainterPod, painterPodState, releasePainterPod } from "@/studio/painter-pod";

/* The painter pod: its state; take one over by id (web); forget it (web). */
export const GET = route(["web", "mcp"], async () => painterPodState());

export const POST = route(["web"], async (req) => {
  const { podId } = await body(req, z.object({ podId: z.string().min(6).max(64) }));
  return adoptPainterPod(podId.trim());
});

export const DELETE = route(["web"], async () => releasePainterPod());
