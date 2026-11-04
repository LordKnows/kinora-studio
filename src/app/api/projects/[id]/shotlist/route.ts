import { body, route } from "@/api/http";
import { getProjectView, saveShotlist } from "@/studio/orchestrator";
import { ShotlistInput } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const view = await getProjectView(params.id!);
  return { approval: view.project.shotlistApproval, scenes: view.scenes };
});

export const PUT = route(["web", "mcp"], async (req, { params }) => {
  const view = await saveShotlist(params.id!, await body(req, ShotlistInput));
  return { approval: view.project.shotlistApproval, merge: view.merge, scenes: view.scenes };
});
