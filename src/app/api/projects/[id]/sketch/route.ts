import { route } from "@/api/http";
import { getProjectView } from "@/studio/orchestrator";
import { sketchBoardSvg } from "@/studio/sketch";

/* The colour-block storyboard as SVG; ?gray=1 for the black-and-white value
   check, ?scene=<id> for one scene of it (an id that is no scene's draws the whole board). */
export const GET = route(["web", "mcp"], async (req, { params }) => {
  const q = new URL(req.url).searchParams;
  const gray = q.get("gray") === "1";
  const svg = sketchBoardSvg(await getProjectView(params.id!), { gray, sceneId: q.get("scene") ?? undefined });
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
});
