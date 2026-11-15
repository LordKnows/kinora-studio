import { body, route } from "@/api/http";
import { addShot } from "@/studio/orchestrator";
import { ShotInput } from "@/studio/schemas";

/* ?position=3 puts the new shot third in the scene (1 = first); without it the shot goes last. */
export const POST = route(["web", "mcp"], async (req, { params }) => {
  const position = Number(new URL(req.url).searchParams.get("position"));
  return { shot: await addShot(params.id!, await body(req, ShotInput), Number.isFinite(position) && position >= 1 ? position : undefined) };
});
