import { body, route } from "@/api/http";
import { addShot } from "@/studio/orchestrator";
import { ShotInput } from "@/studio/schemas";

export const POST = route(["web", "mcp"], async (req, { params }) => ({ shot: await addShot(params.id!, await body(req, ShotInput)) }));
