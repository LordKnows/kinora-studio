import { z } from "zod";

import { body, route } from "@/api/http";
import { ASSET_NAME_MAX } from "@/studio/repo";
import { renamePicture } from "@/studio/pictures";

/* Rename a picture (by id or handle). */
export const PATCH = route(["web", "mcp"], async (req, { params }) => {
  const input = await body(req, z.object({ name: z.string().min(1).max(ASSET_NAME_MAX) }));
  return { picture: await renamePicture(params.id!, decodeURIComponent(params.ref!), input.name) };
});
