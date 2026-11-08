import { body, route } from "@/api/http";
import { CanvasCompose, composeCharacter } from "@/studio/canvas";

/* Canvas: draw a character from portrait + costume + pose (GPT Image, on a painter). */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => composeCharacter(params.id!, await body(req, CanvasCompose), actor));
