import { body, route } from "@/api/http";
import { reviewTake } from "@/studio/orchestrator";
import { ReviewInput } from "@/studio/schemas";
import { z } from "zod";

const Input = ReviewInput.extend({ basis: z.string().max(200).optional() });

export const POST = route(["web", "mcp"], async (req, { params, actor }) => {
  const { score, notes, faults, audioOk, basis } = await body(req, Input);
  return { take: await reviewTake(params.id!, score, notes, actor, { faults, audioOk, basis }) };
});
