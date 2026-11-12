import { z } from "zod";

import { body, route } from "@/api/http";
import { recordReview } from "@/studio/craft";
import * as repo from "@/studio/repo";

/* The person's own verdict on a picture (by id or handle), from the Pictures
   page: the same frame review the director records with record_review, so
   the Board and the Remake gate see it. */
const Verdict = z.object({ verdict: z.enum(["pass", "fail"]), problem: z.string().trim().max(500).optional() });

export const POST = route(["web"], async (req, { params }) => {
  const input = await body(req, Verdict);
  const assetId = await repo.resolveAssetRef(params.id!, decodeURIComponent(params.ref!));
  return recordReview(params.id!, {
    stage: "frame", shotId: assetId, verdict: input.verdict, reviewer: "human", basis: "looked at the picture on the Design page (Pictures tab)",
    findings: input.problem ? [{ where: "picture", problem: input.problem, sure: true, severity: input.verdict === "fail" ? "blocker" : "minor" }] : [],
  });
});
