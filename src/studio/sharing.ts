import { isAdmin, isPerson } from "@/auth/scope";

import { StudioError } from "./errors";
import * as repo from "./repo";
import type { Actor, Project, ProjectVisibility } from "./types";

/* Who owns a project and who sees it (auth/scope.ts applies the rule).

   - A project is owned by whoever created it; shared unless asked otherwise.
   - Only its owner turns it private or back to shared, on the web: through
     the connector the director could otherwise publish a private film.
   - A project from before private projects has no owner. An admin
     (ADMIN_USERS; everyone when that is unset) makes it private and becomes
     its owner. */

export type ProjectView = Project & { mine: boolean };

export function viewOf(actor: Actor, project: Project): ProjectView {
  return { ...project, mine: !!project.owner && project.owner === actor.user };
}

export async function listProjectsFor(actor: Actor): Promise<ProjectView[]> {
  return (await repo.listProjects(actor.user)).map((p) => viewOf(actor, p));
}

export async function createProjectAs(actor: Actor, input: Parameters<typeof repo.createProject>[0] & { visibility?: ProjectVisibility }): Promise<ProjectView> {
  const visibility = input.visibility ?? "shared";
  if (visibility === "private" && !isPerson(actor.user)) {
    throw new StudioError("forbidden", "a private project belongs to a signed-in user; this connection has none (set MCP_STATIC_USER for the static token)");
  }
  const project = await repo.createProject({ ...input, owner: isPerson(actor.user) ? actor.user : undefined, visibility });
  return viewOf(actor, project);
}

export async function setVisibility(actor: Actor, projectId: string, visibility: ProjectVisibility): Promise<ProjectView> {
  if (actor.via !== "web") throw new StudioError("forbidden", "a project is made private or shared by its owner on the web (Settings → Sharing)");
  if (!isPerson(actor.user)) throw new StudioError("forbidden", "sign in to own a project");
  const project = await repo.getProject(projectId);
  if (project.visibility === visibility) return viewOf(actor, project);
  if (project.owner && project.owner !== actor.user) throw new StudioError("forbidden", "only the project's owner can change who sees it");
  if (!project.owner && !isAdmin(actor)) throw new StudioError("forbidden", "this project is from before private projects and has no owner: an admin (ADMIN_USERS) can make it private");
  const owner = project.owner ?? actor.user;
  /* what the library and other projects took from it while it was shared keeps working there, on copies */
  const detached = visibility === "private" ? await repo.detachFromProject(projectId) : 0;
  const next = await repo.setProjectVisibility(projectId, visibility, owner);
  await repo.insertNote(projectId, "decision", "standing", {
    decision: visibility === "private" ? `made private: only ${owner} sees it` : "shared: every signed-in user sees it",
    why: [project.owner ? "" : "claimed: the project had no owner", detached ? `${detached} element(s), shot(s) or voice card(s) elsewhere that used its pictures got copies of their own` : ""].filter(Boolean).join("; "),
    by: actor.user,
    confidence: "user",
  });
  return viewOf(actor, next);
}
