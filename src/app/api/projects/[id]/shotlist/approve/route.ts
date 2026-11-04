import { route } from "@/api/http";
import { StudioError } from "@/studio/errors";
import * as repo from "@/studio/repo";

/* Checkpoint 2 — web only. */
export const POST = route(["web"], async (_req, { params }) => {
  const shots = await repo.listShots(params.id!);
  if (shots.length === 0) throw new StudioError("validation", "nothing to approve: the shotlist is empty");
  return { project: await repo.setShotlistApproval(params.id!, "approved") };
});
