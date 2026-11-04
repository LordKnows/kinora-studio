import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

/* The values to paste when creating the pod by hand in the RunPod console. */
export const GET = route(["web"], async () => gpu.manualPodRecipe());
