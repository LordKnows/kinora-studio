import { route } from "@/api/http";
import { getProjectView } from "@/studio/orchestrator";
import { picturesInUse } from "@/studio/pictures";

/* Every picture of the project with its handle, name and where it is in use (the Pictures page). */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const view = await getProjectView(params.id!);
  const images = view.assets.filter((a) => a.kind === "image" && a.projectId === view.project.id);
  const uses = picturesInUse(view, images.map((a) => a.id));
  return { pictures: images.map((a) => ({ ...a, uses: uses.get(a.id) ?? [] })) };
});
