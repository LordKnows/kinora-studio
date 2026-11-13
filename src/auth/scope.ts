import { config } from "@/studio/config";
import { StudioError, notFound } from "@/studio/errors";
import * as repo from "@/studio/repo";
import type { Actor, ProjectVisibility } from "@/studio/types";

/* Private projects (migration 0020): who may see what.

   A project is shared (every signed-in user, as before) or private (only its
   owner). Everything else in a project — scripts, scenes, shots, takes,
   elements, pictures, jobs, exports, reviews, notes, voice cards, voice jobs — hangs off
   its project_id, so one rule covers it all.

   The rule is applied where a request comes in, not in the repository: every
   web route (src/api/http.ts: path, query and JSON body) and every MCP tool
   (src/mcp/server.ts: its arguments) hands what it was given to
   assertVisible, which finds every Studio id in it by its prefix (ids.ts),
   looks up the project each belongs to and answers not_found — the same
   answer as an id that does not exist — for anything in someone else's
   private project. A new route or tool is covered without being listed, and
   a new field name needs nothing either. The shared machines (the GPU pod,
   the painters, the sweep, the RunPod hooks) work by job id with their own
   tokens and never pass through here: they are shared by everyone. */

const KIND: Record<string, string> = {
  prj: "project", scr: "script", ast: "asset", ele: "element", scn: "scene", sht: "shot", tke: "take", exp: "export",
  job: "job", vc: "voice card", rev: "review", req: "requirement", dec: "decision", vot: "vote", trs: "deleted item", vjb: "voice job",
};

/** A Studio id of something that belongs to a project: prefix, "_", 12 of [0-9a-z] (ids.ts). */
const PROJECT_ID = /^(prj|scr|ast|ele|scn|sht|tke|exp|job|vc|rev|req|dec|vot|trs|vjb)_[0-9a-z]{12}$/;

/** Users that are not a person: they own nothing and see shared projects only. */
const NOBODY = new Set(["anonymous", "mcp-static"]);

export function isPerson(user: string): boolean {
  return !NOBODY.has(user);
}

export function canSee(user: string, project: { owner?: string; visibility: ProjectVisibility }): boolean {
  return project.visibility !== "private" || (!!project.owner && isPerson(user) && project.owner === user);
}

/** Every project-owned id anywhere in a value: strings, array items, object keys (refViews is keyed by asset id) and values. */
export function collectProjectIds(value: unknown, out = new Set<string>(), depth = 0): Set<string> {
  if (depth > 16 || out.size >= 5000) return out;
  if (typeof value === "string") {
    if (value.length <= 24) {
      const v = value.trim();
      if (PROJECT_ID.test(v)) out.add(v);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectProjectIds(v, out, depth + 1);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      collectProjectIds(k, out, depth + 1);
      collectProjectIds(v, out, depth + 1);
    }
  }
  return out;
}

/**
 * Throw not_found for the first id, anywhere in `values`, that belongs to a
 * private project the actor does not own. Ids that exist nowhere are left to
 * the handler (it answers not_found itself); library rows (no project) are
 * shared.
 */
export async function assertVisible(actor: Actor, ...values: unknown[]): Promise<void> {
  if (actor.via === "hook") return;
  const ids = new Set<string>();
  for (const v of values) collectProjectIds(v, ids);
  if (!ids.size) return;

  const projectOf = new Map<string, string | null>();
  const byTable = new Map<(typeof repo.PROJECT_TABLE_OF_PREFIX)[keyof typeof repo.PROJECT_TABLE_OF_PREFIX], string[]>();
  for (const id of ids) {
    const prefix = id.slice(0, id.indexOf("_"));
    if (prefix === "prj") {
      projectOf.set(id, id);
      continue;
    }
    const table = repo.PROJECT_TABLE_OF_PREFIX[prefix as keyof typeof repo.PROJECT_TABLE_OF_PREFIX];
    byTable.set(table, [...(byTable.get(table) ?? []), id]);
  }
  for (const [table, list] of byTable) {
    for (const [id, projectId] of await repo.projectIdsOf(table, list)) projectOf.set(id, projectId);
  }

  const projectIds = [...new Set([...projectOf.values()].filter((p): p is string => !!p))];
  if (!projectIds.length) return;
  const access = await repo.projectAccessRows(projectIds);
  for (const [id, projectId] of projectOf) {
    const a = projectId ? access.get(projectId) : undefined;
    if (a && !canSee(actor.user, a)) throw notFound(KIND[id.slice(0, id.indexOf("_"))] ?? "object", id);
  }
}

/** One project, for callers that hold a project id that did not come from the request. */
export async function assertProjectVisible(actor: Actor, projectId: string): Promise<void> {
  return assertVisible(actor, projectId);
}

/* ---------- the shared machines ---------- */

export function isAdmin(actor: Actor): boolean {
  const admins = config.adminUsers();
  if (!admins.length) return isPerson(actor.user);
  return isPerson(actor.user) && admins.includes(actor.user.toLowerCase());
}

/** Machine controls that change the shared GPU pod or the painters for everyone. */
export function requireAdmin(actor: Actor, what: string): void {
  if (!isAdmin(actor)) throw new StudioError("forbidden", `${what} is for the studio's admins (ADMIN_USERS): the machines are shared by every user`);
}
