import { route } from "@/api/http";
import * as repo from "@/studio/repo";

/* Checkpoint 1 — web only. */
export const POST = route(["web"], async (_req, { params }) => ({ script: await repo.approveScript(params.id!) }));
