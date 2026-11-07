import { route } from "@/api/http";
import { config } from "@/studio/config";

export const GET = route(["web", "mcp"], async (_req, { actor }) => ({
  user: actor.user,
  via: actor.via,
  authMode: config.authMode(),
  runpodConfigured: (() => { try { config.runpod(); return true; } catch { return false; } })(),
  r2Configured: config.r2Configured(),
  /* GPT Image is drawn by painters (workers/painter), switched per project. */
  imageGeneration: "painters",
}));
