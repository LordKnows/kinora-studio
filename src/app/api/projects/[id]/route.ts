import { body, route } from "@/api/http";
import { getProjectView, removeProject } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { ProjectPatch } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => getProjectView(params.id!));

export const PATCH = route(["web", "mcp"], async (req, { params }) => ({ project: await repo.updateProject(params.id!, await body(req, ProjectPatch)) }));

export const DELETE = route(["web"], async (_req, { params, actor }) => ({ ok: true, ...(await removeProject(params.id!, actor.user)) }));
