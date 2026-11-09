import { body, route } from "@/api/http";
import { CanvasCompose, composeCharacter } from "@/studio/canvas";

/* Canvas: draw a character from portrait + costume + pose (the model picked on the page, else the project's). */
export const POST = route(["web", "mcp"], async (req, { params, actor }) => composeCharacter(params.id!, await body(req, CanvasCompose), actor));
