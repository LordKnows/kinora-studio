import { route } from "@/api/http";
import { refreshExport } from "@/studio/orchestrator";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ export: await refreshExport(params.id!) }));
