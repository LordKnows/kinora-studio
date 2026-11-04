import { route } from "@/api/http";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ script: await repo.getScript(params.id!) }));
