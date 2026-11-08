import { body, route } from "@/api/http";
import { CanvasImport, importReference } from "@/studio/canvas";

/* Canvas: bring one reference picture into the project (fetched once from its gallery). */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => importReference(params.id!, await body(req, CanvasImport), actor));
