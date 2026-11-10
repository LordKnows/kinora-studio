import { z } from "zod";

import { body, route } from "@/api/http";
import { StudioError } from "@/studio/errors";
import * as repo from "@/studio/repo";
import { MAX_ELEMENT_REFS, REF_VIEWS } from "@/studio/schemas";

/* GET lists the element's current references; POST replaces the chosen set.
   References are uploads, imports, or GPT Image sheets (generate_element_sheet). */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const element = await repo.getElement(params.id!);
  const assets = await repo.getAssets(element.refAssetIds);
  return { refs: element.refAssetIds.map((id) => assets.get(id)).filter(Boolean) };
});

export const POST = route(["web", "mcp"], async (req, { params }) => {
  const { assetIds, views, features } = await body(req, z.object({ assetIds: z.array(z.string()).max(MAX_ELEMENT_REFS), views: z.record(z.string(), z.enum(REF_VIEWS)).optional(), features: z.record(z.string(), z.string().max(80)).optional() }));
  const assets = await repo.getAssets(assetIds);
  for (const id of assetIds) if (!assets.has(id)) throw new StudioError("validation", `unknown asset ${id}`);
  return { element: await repo.updateElement(params.id!, { refAssetIds: assetIds, ...(views ? { refViews: views } : {}), ...(features ? { refFeatures: features } : {}) }) };
});
