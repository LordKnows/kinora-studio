import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";
import { MODELS } from "@/studio/models";
import { runnerSummary } from "@/studio/painter";
import * as repo from "@/studio/repo";

/* The model registry (models.ts) with what can draw each image model right
   now, the GPU pod's state (pod models draw only while it runs) and the
   LoRA library grouped by the model family each LoRA was trained for. */
export const GET = route(["web", "mcp"], async (req) => {
  const kind = new URL(req.url).searchParams.get("kind");
  const models = MODELS.filter((m) => !kind || m.kind === kind);
  const [loras, gpuState] = await Promise.all([repo.listLoras(), gpu.getGpuState().catch(() => null)]);
  const ready = await Promise.all(models.map((m) => (m.kind === "image" && m.backend ? runnerSummary("paint", m.backend) : Promise.resolve(undefined))));
  return {
    models: models.map((m, i) => ({ ...m, ...(ready[i] ? { painters: ready[i] } : {}) })),
    gpu: gpuState ? { status: gpuState.status, configured: gpuState.configured } : null,
    loras,
  };
});
