import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* Web only: put the studio's boot command and env on the current pod and restart it. */
export const POST = route(["web"], async () => gpu.repairGpu());
