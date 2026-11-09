import { body, route } from "@/api/http";
import { StudioError } from "@/studio/errors";
import { imageInfo } from "@/studio/images";
import * as repo from "@/studio/repo";
import { CommitUploadRequest } from "@/studio/schemas";
import { getObject, nameOfUploadKey, objectExists, publicUrl } from "@/studio/storage/r2";

/* Images get their size from the header, so the frame checks (aspect ratio,
   first and last frame alike) can run. */
async function headerSize(key: string): Promise<{ width?: number; height?: number }> {
  try {
    const res = await getObject(key, "bytes=0-131071");
    if (!res.ok) return {};
    const info = imageInfo(new Uint8Array(await res.arrayBuffer()));
    return info ? { width: info.width, height: info.height } : {};
  } catch {
    return {};
  }
}

export const POST = route(["web"], async (req) => {
  const input = await body(req, CommitUploadRequest);
  if (!input.key.startsWith("uploads/")) throw new StudioError("validation", "key must be under uploads/");
  if (!(await objectExists(input.key))) throw new StudioError("validation", "object not found in the bucket; upload first");
  if (input.projectId) await repo.getProject(input.projectId);
  const size = input.kind === "image" ? await headerSize(input.key) : {};
  return { asset: await repo.createAsset({ projectId: input.projectId ?? null, url: publicUrl(input.key), kind: input.kind, source: "upload", ...size, meta: { key: input.key, ...(input.kind === "image" && input.purpose ? { purpose: input.purpose } : {}) }, name: nameOfUploadKey(input.key) }) };
});
