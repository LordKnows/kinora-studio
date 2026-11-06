import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { ScenePalette } from "@/studio/schemas";

export const PUT = route(["web", "mcp"], async (req, { params }) => {
  const { palette } = await body(req, z.object({ palette: ScenePalette.nullable() }));
  return { scene: await repo.updateScene(params.id!, { palette }) };
});
