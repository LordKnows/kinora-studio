import { route } from "@/api/http";
import * as repo from "@/studio/repo";

/* Requirements, the decision log and the stage reviews, for the Board. */
export const GET = route(["web", "mcp"], async (_req, { params }) => {
  const [requirements, decisions, reviews] = await Promise.all([
    repo.listNotes(params.id!, "requirement"), repo.listNotes(params.id!, "decision"), repo.listReviews(params.id!),
  ]);
  return { requirements, decisions, reviews };
});
