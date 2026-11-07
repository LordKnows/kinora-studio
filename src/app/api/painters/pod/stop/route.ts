import { route } from "@/api/http";
import { stopPainterPod } from "@/studio/painter-pod";

/* Stop the painter pod by hand (it also stops by itself after idling). */
export const POST = route(["web"], async () => stopPainterPod("stopped on the Machine page"));
