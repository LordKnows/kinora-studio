import { z } from "zod";

import { body, route } from "@/api/http";
import { jobAssets, refreshJob } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";

/* GET lists every generated candidate for this element (refreshing jobs in
   flight); POST replaces the chosen set. */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const jobs = await jobAssets(params.id!);
  for (const job of jobs) if (job.status === "running" || job.status === "queued") await refreshJob(job.id);
  return { jobs: await jobAssets(params.id!) };
});

export const POST = route(["web", "mcp"], async (req, { params }) => {
  const { assetIds } = await body(req, z.object({ assetIds: z.array(z.string()).max(6) }));
  const assets = await repo.getAssets(assetIds);
  for (const id of assetIds) if (!assets.has(id)) throw new (await import("@/studio/errors")).StudioError("validation", `unknown asset ${id}`);
  return { element: await repo.updateElement(params.id!, { refAssetIds: assetIds }) };
});
