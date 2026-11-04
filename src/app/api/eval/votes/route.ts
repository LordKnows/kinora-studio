import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { EvalVote } from "@/studio/schemas";

export const POST = route(["web"], async (req, { actor }) => {
  const vote = await body(req, EvalVote);
  const a = await repo.getTake(vote.takeA);
  await repo.insertEvalVote({ projectId: a.projectId, takeA: vote.takeA, takeB: vote.takeB, winner: vote.winner, scores: vote.scores, voter: actor.user });
  return { ok: true };
});
