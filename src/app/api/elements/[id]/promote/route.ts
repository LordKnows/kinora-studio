import { route } from "@/api/http";
import * as repo from "@/studio/repo";

/* Copy into the global library (projectId = null). Web only. */
export const POST = route(["web"], async (_req, { params }) => ({ element: await repo.copyElement(params.id!, null) }));
