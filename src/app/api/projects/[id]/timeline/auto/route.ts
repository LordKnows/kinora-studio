import { route } from "@/api/http";
import { autoTimeline } from "@/studio/orchestrator";

export const POST = route(["web", "mcp"], async (_req, { params }) => ({ timeline: await autoTimeline(params.id!) }));
