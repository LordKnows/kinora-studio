import { body, route } from "@/api/http";
import { generateImages, jobAssets, refreshJob } from "@/studio/orchestrator";
import { GenerateImagesRequest } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const jobs = await jobAssets(params.id!);
  for (const job of jobs) if (job.status === "running" || job.status === "queued") await refreshJob(job.id);
  return { jobs: await jobAssets(params.id!) };
});

export const POST = route(["web", "mcp"], async (req, { params, actor }) => generateImages("hero-frames", params.id!, await body(req, GenerateImagesRequest), actor));
