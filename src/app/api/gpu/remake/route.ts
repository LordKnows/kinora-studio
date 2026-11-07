import { z } from "zod";

import { body, route } from "@/api/http";
import { remakeInstall, remakeStatus } from "@/studio/gpu";

/* Viggle Remake on the pod: which modes are ready, and the download onto the volume (web only). */
export const GET = route(["web"], async () => remakeStatus());
export const POST = route(["web"], async (req) => {
  const { modes } = await body(req, z.object({ modes: z.array(z.enum(["edit", "swap"])).min(1).default(["edit", "swap"]) }));
  return remakeInstall(modes);
});
