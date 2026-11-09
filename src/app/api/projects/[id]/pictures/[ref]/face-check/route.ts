import { route } from "@/api/http";
import { faceVerdict } from "@/studio/face-check";
import { resolvePicture } from "@/studio/pictures";
import * as repo from "@/studio/repo";

/* Run a picture's face check again (放行 / 不放行 for R18): after a failed check, or a verdict that looks wrong. */
export const POST = route(["web"], async (_req, { params }) => {
  const asset = await resolvePicture(params.id!, decodeURIComponent(params.ref!));
  await faceVerdict(asset, { force: true });
  return { picture: await repo.getAsset(asset.id) };
});
