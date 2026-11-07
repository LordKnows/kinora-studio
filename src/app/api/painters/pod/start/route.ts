import { route } from "@/api/http";
import { startPainterPod } from "@/studio/painter-pod";

/* Start the painter pod by hand (it also starts by itself when pictures are queued). */
export const POST = route(["web"], async () => startPainterPod("started on the Machine page"));
