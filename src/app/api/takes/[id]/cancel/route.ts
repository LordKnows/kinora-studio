import { route } from "@/api/http";
import { cancelTake } from "@/studio/orchestrator";

export const POST = route(["web", "mcp"], async (_req, { params }) => ({ take: await cancelTake(params.id!) }));
