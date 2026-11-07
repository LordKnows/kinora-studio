import { route } from "@/api/http";
import { requestCodexLogin } from "@/studio/painter";

/* Start the Codex device-code login on a painter (web only); the code shows up in GET /api/painters. */
export const POST = route(["web"], async (_req, { params }) => ({ painter: await requestCodexLogin(params.id!) }));
