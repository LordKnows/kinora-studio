import { route } from "@/api/http";
import { stopPainterPod } from "@/studio/painter-pod";

/* Terminate the painter pod now (it is also terminated by itself after idling; the volume keeps the login). */
export const POST = route(["web"], async () => stopPainterPod("terminated on the Machine page"));
