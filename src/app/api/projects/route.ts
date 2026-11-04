import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { ProjectInput } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async () => ({ projects: await repo.listProjects() }));

export const POST = route(["web", "mcp"], async (req) => {
  const input = await body(req, ProjectInput);
  return { project: await repo.createProject(input) };
});
