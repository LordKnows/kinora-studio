import { body, route } from "@/api/http";
import { createExportJob, refreshExport } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ExportRequest } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const jobs = await repo.listExports(params.id!);
  const fresh = [];
  for (const job of jobs) fresh.push(job.status === "queued" || job.status === "running" ? await refreshExport(job.id) : job);
  return { exports: fresh };
});

export const POST = route(["web", "mcp"], async (req, { params, actor }) => createExportJob(params.id!, await body(req, ExportRequest), actor));
