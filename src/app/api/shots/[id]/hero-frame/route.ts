import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const POST = route(["web", "mcp"], async (req, { params }) => {
  const { assetId } = await body(req, z.object({ assetId: z.string().nullable() }));
  if (assetId) await repo.getAsset(assetId);
  return { shot: await repo.updateShot(params.id!, { heroAssetId: assetId }) };
});
