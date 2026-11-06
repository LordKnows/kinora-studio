import { z } from "zod";

import { body, route } from "@/api/http";
import { setRequirement } from "@/studio/craft";

export const PATCH = route(["web", "mcp"], async (req, { params }) => {
  const { status, note } = await body(req, z.object({ status: z.enum(["open", "met", "dropped"]), note: z.string().max(300).optional() }));
  return { requirement: await setRequirement(params.id!, status, note) };
});
