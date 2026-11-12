import { z } from "zod";

import { body, route } from "@/api/http";
import { setVisibility } from "@/studio/sharing";

/* Private or shared: the owner's call, on the web only (sharing.ts). */
export const PUT = route(["web"], async (req, { params, actor }) => {
  const { visibility } = await body(req, z.object({ visibility: z.enum(["shared", "private"]) }));
  return { project: await setVisibility(actor, params.id!, visibility) };
});
