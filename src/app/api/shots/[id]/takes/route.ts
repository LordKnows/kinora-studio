import { body, route } from "@/api/http";
import { createTakes, refreshTake } from "@/studio/orchestrator";
import * as repo from "@/studio/repo";
import { TakeRequest } from "@/studio/schemas";

export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const takes = await repo.listShotTakes(params.id!);
  const fresh = [];
  for (const take of takes) fresh.push(take.status === "queued" || take.status === "running" ? await refreshTake(take.id) : take);
  return { takes: fresh };
});

export const POST = route(["web", "mcp"], async (req, { params, actor }) => createTakes(params.id!, await body(req, TakeRequest), actor));
