import { route } from "@/api/http";
import { buildRetro } from "@/studio/craft";

export const GET = route(["web", "mcp"], async (_req, { params }) => new Response(await buildRetro(params.id!), { headers: { "content-type": "text/markdown; charset=utf-8" } }));
