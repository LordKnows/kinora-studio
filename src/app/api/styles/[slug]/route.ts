import { route } from "@/api/http";
import * as director from "@/director";
import { StudioError } from "@/studio/errors";

/* One preset in full: the JSON, its STYLE.md, and the Look it compiles to. */
export const GET = route(["web", "mcp"], async (req, { params }) => {
  const found = director.findStyle(params.slug!);
  if (!found) throw new StudioError("not_found", `no style ${params.slug}`);
  const url = new URL(req.url);
  const aspect = url.searchParams.get("aspectRatio") ?? undefined;
  return {
    style: found.style,
    markdown: director.styleToMarkdown(found.style),
    look: director.compileLook(found.style, { aspectRatio: aspect as never }),
    beatSuffix: found.style.engine.beatSuffix,
    cinematographyDefaults: found.style.engine.cinematography,
    allowedCameraMoves: found.style.camera.grammar.map((g) => g.move),
    durationGuide: found.style.engine.durations,
  };
});
