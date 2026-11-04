import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const GET = route(["web", "mcp"], async (_req, { params }) => ({ scripts: await repo.listScripts(params.id!) }));

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  const { text } = await body(req, z.object({ text: z.string().min(1).max(200_000) }));
  return { script: await repo.createScript(params.id!, text) };
});
