import { route } from "@/api/http";
import { requireAdmin } from "@/auth/scope";
import { requestCodexLogin } from "@/studio/painter";

/* Admins (web only): start the Codex device-code login on a painter; the code shows up in GET /api/painters, to admins. */
export const POST = route(["web"], async (_req, { params, actor }) => {
  requireAdmin(actor, "logging a painter in to Codex");
  return { painter: await requestCodexLogin(params.id!) };
});
