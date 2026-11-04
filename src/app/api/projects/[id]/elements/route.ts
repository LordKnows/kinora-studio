import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { ElementInput } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (req, { params }) => {
  const includeLibrary = new URL(req.url).searchParams.get("includeLibrary") === "1";
  const elements = await repo.listElements(params.id!, includeLibrary);
  const assets = await repo.getAssets(elements.flatMap((e) => e.refAssetIds));
  return { elements: elements.map((e) => ({ ...e, refs: e.refAssetIds.map((id) => assets.get(id)).filter(Boolean) })) };
});

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  return { element: await repo.createElement(params.id!, await body(req, ElementInput)) };
});
