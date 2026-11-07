import { z } from "zod";

import { body, route } from "@/api/http";
import { deletePictures } from "@/studio/pictures";

/* Delete pictures in a batch (ids or handles). In-use pictures need confirm: they are taken out of their shots, elements and the Look first. */
export const POST = route(["web"], async (req, { params, actor }) => {
  const input = await body(req, z.object({ refs: z.array(z.string().min(1).max(80)).min(1).max(200), confirm: z.boolean().default(false) }));
  return deletePictures(params.id!, input.refs, actor, { confirm: input.confirm });
});
