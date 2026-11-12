import { route } from "@/api/http";
import { canSee } from "@/auth/scope";
import * as trash from "@/studio/trash";

/* Deleted projects the caller may see and put back (the Projects page). */
export const GET = route(["web"], async (_req, { actor }) => ({
  projects: (await trash.listProjects()).filter((p) => canSee(actor.user, p)).map(({ owner: _owner, ...p }) => p),
  days: trash.TRASH_DAYS,
}));
