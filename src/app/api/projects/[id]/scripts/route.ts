import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import * as treatments from "@/studio/treatment";

/* The versions, newest first, with the treatment kept for the project and what the lint says about it. */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const scripts = await repo.listScripts(params.id!);
  const treatment = await treatments.currentTreatment(params.id!);
  return { scripts, treatment: treatment ?? null, treatmentWarnings: treatments.treatmentLint(treatment, scripts[0]?.version) };
});

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  const { text } = await body(req, z.object({ text: z.string().min(1).max(200_000) }));
  return { script: await repo.createScript(params.id!, text) };
});
