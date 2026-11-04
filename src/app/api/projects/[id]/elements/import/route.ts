import { z } from "zod";

import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";

export const POST = route(["web", "mcp"], async (req, { params }) => {
  await repo.getProject(params.id!);
  const { elementId } = await body(req, z.object({ elementId: z.string() }));
  return { element: await repo.copyElement(elementId, params.id!) };
});
