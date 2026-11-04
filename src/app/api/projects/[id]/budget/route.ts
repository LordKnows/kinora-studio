import { route } from "@/api/http";
import { estimateTake } from "@/studio/cost";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const project = await repo.getProject(params.id!);
  return { capUsd: project.budgetCapUsd, spentUsd: project.spentUsd, remainingUsd: Math.max(0, project.budgetCapUsd - project.spentUsd), estimatePerTake: estimateTake(8, 8) };
});
