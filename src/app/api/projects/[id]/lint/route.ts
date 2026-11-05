import { route } from "@/api/http";
import { lintProject } from "@/studio/orchestrator";

/* Rhythm / craft lint of the saved shotlist plus Tier 2 / Tier 3 completeness. */
export const GET = route(["web", "mcp"], async (_req, { params }) => lintProject(params.id!));
