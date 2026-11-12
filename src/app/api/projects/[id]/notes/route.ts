import { z } from "zod";

import { body, route } from "@/api/http";
import * as craft from "@/studio/craft";
import * as repo from "@/studio/repo";

/* Requirements, the decision log and the stage reviews, for the Board. */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const [requirements, decisions, reviews] = await Promise.all([
    repo.listNotes(params.id!, "requirement"), repo.listNotes(params.id!, "decision"), repo.listReviews(params.id!),
  ]);
  return { requirements, decisions, reviews };
});

/* A requirement in the user's own words, from the web: the same list the
   director writes to with add_requirements, so it rides in every review. */
const NewRequirement = z.object({ text: z.string().trim().min(1).max(500) });

export const POST = route(["web", "mcp"], async (req, { params }) => {
  const { text } = await body(req, NewRequirement);
  const added = await craft.addRequirements(params.id!, [{ text, source: "web" }]);
  return { added, requirements: await repo.listNotes(params.id!, "requirement") };
});
