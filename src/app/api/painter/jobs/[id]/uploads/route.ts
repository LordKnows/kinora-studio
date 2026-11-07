import { z } from "zod";

import { body, route } from "@/api/http";
import { checkPainterToken, uploadUrls } from "@/studio/painter";

/* Presigned PUTs for the files of a job the painter holds (picture, preview, diff). */
export const POST = route("public", async (req, { params }) => {
  checkPainterToken(req);
  const input = await body(req, z.object({ painterId: z.string().min(1).max(80), keys: z.array(z.string().max(300)).min(1).max(6) }));
  return { uploads: await uploadUrls(params.id!, input.painterId, input.keys) };
});
