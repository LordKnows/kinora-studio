import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const POST = route(["web", "mcp"], async (req) => {
  const { sceneId, shotIds } = await body(req, z.object({ sceneId: z.string(), shotIds: z.array(z.string()).min(1) }));
  await repo.reorderShots(sceneId, shotIds);
  return { shots: await repo.listSceneShots(sceneId) };
});
