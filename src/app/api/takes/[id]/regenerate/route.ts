import { body, route } from "@/api/http";
import { regenerateTake, cancelUpscale } from "@/studio/orchestrator";
import { UpscaleRequest } from "@/studio/schemas";

/* Open-H3-Regenerate-2K: re-generate a completed take at 1080p / 2K / 4K. */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => regenerateTake(params.id!, await body(req, UpscaleRequest), actor));
export const DELETE = route(["web", "mcp"], async (_req, { params }) => ({ take: await cancelUpscale(params.id!) }));
