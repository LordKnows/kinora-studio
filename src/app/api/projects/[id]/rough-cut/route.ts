import { route } from "@/api/http";
import { roughCut } from "@/studio/orchestrator";

/* Assemble what is rendered, in order, and list what is missing. */
export const POST = route(["web", "mcp"], async (_req, { params }) => roughCut(params.id!));
