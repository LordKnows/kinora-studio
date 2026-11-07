import { body, route } from "@/api/http";
import { ImageAction, runImageAction } from "@/studio/image-actions";
import { listImageJobs } from "@/studio/imaging";

/* Image jobs of a project: list them, or start one (sheet, frame, edit, extract, style frame). */
export const GET = route(["web", "mcp"], async (_req, { params }) => ({ jobs: await listImageJobs(params.id!) }));

export const POST = route(["web", "mcp"], async (req, { params, actor }) => runImageAction(params.id!, await body(req, ImageAction), actor));
