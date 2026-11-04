import { route } from "@/api/http";
import { refreshJob } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const job = await refreshJob(params.id!);
  const assets = await repo.getAssets(job.assetIds);
  return { job: { ...job, assets: job.assetIds.map((id) => assets.get(id)).filter(Boolean) } };
});
