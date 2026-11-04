import { body, route } from "@/api/http";
import { reviewTake } from "@/studio/orchestrator";
import { ReviewInput } from "@/studio/schemas";

export const POST = route(["web", "mcp"], async (req, { params, actor }) => {
  const { score, notes } = await body(req, ReviewInput);
  return { take: await reviewTake(params.id!, score, notes, actor) };
});
