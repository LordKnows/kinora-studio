import { route } from "@/api/http";
import { checkSeams } from "@/studio/orchestrator";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ warnings: await checkSeams(params.id!) }));
