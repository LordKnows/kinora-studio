import { route } from "@/api/http";
import { config } from "@/studio/config";
import { listPainters } from "@/studio/painter";

/* The machines that draw pictures, for the Machine page, and how to start one. */
export const GET = route(["web", "mcp"], async () => ({
  painters: await listPainters(),
  setup: { studioUrl: config.publicUrl(), tokenSet: Boolean(config.painterToken()), ownToken: Boolean(process.env.PAINTER_TOKEN), painterOnPod: config.painterOnPod() },
}));
