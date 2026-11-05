import { z } from "zod";

import { body, route } from "@/api/http";
import { applyStyleToProject } from "@/studio/orchestrator";

/* Fill the shotlist's cinematography from a style preset and save it. */
export const POST = route(["web", "mcp"], async (req, { params }) => {
  const input = await body(req, z.object({ style: z.string().min(1), beatSuffix: z.boolean().default(true), musicForShotsWithScore: z.boolean().default(true) }));
  const { warnings, view } = await applyStyleToProject(params.id!, input.style, input);
  return { warnings, approval: view.project.shotlistApproval };
});
