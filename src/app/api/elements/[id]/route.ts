import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { ElementPatch } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const element = await repo.getElement(params.id!);
  const assets = await repo.getAssets(element.refAssetIds);
  return { element: { ...element, refs: element.refAssetIds.map((id) => assets.get(id)).filter(Boolean) } };
});

export const PATCH = route(["web", "mcp"], async (req, { params }) => ({ element: await repo.updateElement(params.id!, await body(req, ElementPatch)) }));

export const DELETE = route(["web"], async (_req, { params }) => {
  await repo.getElement(params.id!);
  await repo.deleteElement(params.id!);
  return { ok: true };
});
