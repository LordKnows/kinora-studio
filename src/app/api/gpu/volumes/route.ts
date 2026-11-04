import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* The network volumes this RunPod key can see, with the configured one
   flagged — the first thing to check when a pod says "volume not found". */
export const GET = route(["web", "mcp"], async () => gpu.listVolumes());
