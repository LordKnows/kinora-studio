import { body, route } from "@/api/http";
import { StudioError } from "@/studio/errors";
import * as repo from "@/studio/repo";
import { CommitUploadRequest } from "@/studio/schemas";
import { objectExists, publicUrl } from "@/studio/storage/r2";

export const POST = route(["web"], async (req) => {
  const input = await body(req, CommitUploadRequest);
  if (!input.key.startsWith("uploads/")) throw new StudioError("validation", "key must be under uploads/");
  if (!(await objectExists(input.key))) throw new StudioError("validation", "object not found in the bucket; upload first");
  if (input.projectId) await repo.getProject(input.projectId);
  return { asset: await repo.createAsset({ projectId: input.projectId ?? null, url: publicUrl(input.key), kind: input.kind, source: "upload", meta: { key: input.key } }) };
});
