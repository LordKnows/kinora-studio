import { route } from "@/api/http";
import { isAdmin } from "@/auth/scope";
import { config } from "@/studio/config";
import { listPainters } from "@/studio/painter";

/* The machines that draw pictures, for the Machine page, and how to start one.
   A Codex login code in flight is shown to admins only: whoever enters it
   decides whose ChatGPT plan the shared painter draws on. */
export const GET = route(["web", "mcp"], async (_req, { actor }) => ({
  painters: (await listPainters()).map((p) => (isAdmin(actor) || !p.info.login ? p : { ...p, info: { ...p.info, login: { state: p.info.login.state } } })),
  admin: isAdmin(actor),
  setup: { studioUrl: config.publicUrl(), tokenSet: Boolean(config.painterToken()), ownToken: Boolean(process.env.PAINTER_TOKEN), painterOnPod: config.painterOnPod() },
}));
