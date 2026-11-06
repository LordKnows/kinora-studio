import { route } from "@/api/http";
import { getProjectView } from "@/studio/orchestrator";
import { sketchBoardSvg } from "@/studio/sketch";

/* The colour-block storyboard as SVG; ?gray=1 for the black-and-white value check. */
export const GET = route(["web", "mcp"], async (req, { params }) => {
  const gray = new URL(req.url).searchParams.get("gray") === "1";
  const svg = sketchBoardSvg(await getProjectView(params.id!), { gray });
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "no-store" } });
});
