import { route } from "@/api/http";
import { refreshTake, removeTake } from "@/studio/orchestrator";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ take: await refreshTake(params.id!) }));

/* Web only: a finished take is deleted by a person (and can be put back for 14 days). */
export const DELETE = route(["web"], async (_req, { params, actor }) => ({ ok: true, ...(await removeTake(params.id!, actor.user)) }));
