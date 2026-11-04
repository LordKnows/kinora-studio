import { route } from "@/api/http";
import { compileForShot } from "@/studio/orchestrator";

export const GET = route(["web", "mcp"], async (req, { params }) => {
  const q = new URL(req.url).searchParams;
  const steps = q.get("steps") ? Number(q.get("steps")) : undefined;
  return compileForShot(params.id!, { steps });
});
