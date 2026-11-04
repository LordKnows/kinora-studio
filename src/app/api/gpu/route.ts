import { route } from "@/api/http";
import { config } from "@/studio/config";
import * as gpu from "@/studio/gpu";

/* The GPU pod the studio manages. GET refreshes from RunPod when configured. */
export const GET = route(["web", "mcp"], async () => {
  if (config.runpodMode() === "pod" && gpu.gpuConfigured()) {
    try {
      await gpu.refreshGpu();
    } catch {
      /* RunPod unreachable: show the last known state */
    }
  }
  return gpu.getGpuState();
});
