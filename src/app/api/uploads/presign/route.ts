import { body, route } from "@/api/http";
import { StudioError } from "@/studio/errors";
import { config } from "@/studio/config";
import { PresignRequest } from "@/studio/schemas";
import { presignPut, uploadKey } from "@/studio/storage/r2";

export const POST = route(["web"], async (req, { actor }) => {
  if (!config.r2Configured()) throw new StudioError("backend_error", "R2 is not configured");
  const input = await body(req, PresignRequest);
  const key = uploadKey(actor.user, input.filename);
  const { url, expiresAt } = await presignPut(key, input.contentType, input.size);
  return { url, key, expiresAt };
});
