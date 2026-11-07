import { route } from "@/api/http";
import { cancelImageJob } from "@/studio/imaging";

/* Withdraw a queued or running picture (nothing is attached or counted). */
export const POST = route(["web", "mcp"], async (_req, { params, actor }) => ({ job: await cancelImageJob(params.id!, actor) }));
