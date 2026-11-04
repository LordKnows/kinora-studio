import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* Per GPU type: generation seconds, video seconds, speed and USD per video
   second — the numbers to rank the allow-list by. */
export const GET = route(["web", "mcp"], async () => ({ stats: await gpu.gpuStats(), estimateBasis: await gpu.measuredForEstimate() }));
