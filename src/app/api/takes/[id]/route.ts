import { route } from "@/api/http";
import { refreshTake } from "@/studio/orchestrator";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ take: await refreshTake(params.id!) }));
