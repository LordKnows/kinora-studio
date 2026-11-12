import { body, route } from "@/api/http";
import { ProjectInput } from "@/studio/schemas";
import { createProjectAs, listProjectsFor } from "@/studio/sharing";

/* Every shared project and the caller's own private ones. */
export const GET = route(["web", "mcp"], async (_req, { actor }) => ({ projects: await listProjectsFor(actor) }));

export const POST = route(["web", "mcp"], async (req, { actor }) => {
  const input = await body(req, ProjectInput);
  return { project: await createProjectAs(actor, input) };
});
