import { route } from "@/api/http";
import { refreshImageJob } from "@/studio/imaging";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const job = await refreshImageJob(params.id!);
  const assets = await repo.getAssets(job.assetIds);
  return { job, assets: job.assetIds.map((id) => assets.get(id)).filter(Boolean) };
});
