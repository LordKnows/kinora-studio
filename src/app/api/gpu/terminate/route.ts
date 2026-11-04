import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* Web only: terminating deletes the pod's container disk. */
export const POST = route(["web"], async () => gpu.terminateGpu());
