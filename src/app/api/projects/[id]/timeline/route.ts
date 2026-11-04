import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { TimelineInput } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ timeline: await repo.getTimeline(params.id!) }));

export const PUT = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  return { timeline: await repo.setTimeline(params.id!, await body(req, TimelineInput)) };
});
