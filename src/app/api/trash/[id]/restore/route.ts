import { route } from "@/api/http";
import { assertProjectVisible, canSee } from "@/auth/scope";
import { notFound } from "@/studio/errors";
import * as trash from "@/studio/trash";

/* Put a deleted shot, scene, element, pictures or project back. The trash id
   carries no project prefix, so the caller's right to see it is checked here:
   a project by the owner and visibility it had, anything else by its project. */
export const POST = route(["web"], async (_req, { params, actor }) => {
  const entry = await trash.get(params.id!);
  if (entry.kind === "project") {
    if (!canSee(actor.user, { owner: entry.payload.owner, visibility: entry.payload.visibility === "private" ? "private" : "shared" })) throw notFound("deleted item", entry.id);
  } else if (entry.projectId) {
    await assertProjectVisible(actor, entry.projectId);
  }
  const restored = await trash.restore(entry.id);
  return { restored: { id: restored.id, kind: restored.kind, label: restored.label, projectId: restored.projectId } };
});
