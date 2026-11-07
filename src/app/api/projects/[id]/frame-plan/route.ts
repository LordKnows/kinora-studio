import { route } from "@/api/http";
import { planFrames } from "@/studio/imaging";
import { getProjectView } from "@/studio/orchestrator";

/* Where every shot's first and last frame come from, cheapest first. */
export const GET = route(["web", "mcp"], async (_req, { params }) => planFrames(await getProjectView(params.id!)));
