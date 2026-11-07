import { route } from "@/api/http";
import { startPainterPod } from "@/studio/painter-pod";

/* Create the painter pod now (it is also created by itself when pictures are queued). */
export const POST = route(["web"], async () => startPainterPod("started on the Machine page"));
