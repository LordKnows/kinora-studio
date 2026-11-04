import { route } from "@/api/http";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async () => {
  const elements = await repo.listLibraryElements();
  const assets = await repo.getAssets(elements.flatMap((e) => e.refAssetIds));
  return { elements: elements.map((e) => ({ ...e, refs: e.refAssetIds.map((id) => assets.get(id)).filter(Boolean) })) };
});
