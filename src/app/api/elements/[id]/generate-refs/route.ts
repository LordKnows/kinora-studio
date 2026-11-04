import { body, route } from "@/api/http";
import { generateImages } from "@/studio/orchestrator";
import { GenerateImagesRequest } from "@/studio/schemas";

export const POST = route(["web", "mcp"], async (req, { params, actor }) => generateImages("element-refs", params.id!, await body(req, GenerateImagesRequest), actor));
