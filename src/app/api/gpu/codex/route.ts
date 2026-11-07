import { route } from "@/api/http";
import { codexLogin, codexStatus } from "@/studio/gpu";

/* Codex on the pod: login status, and the device-code login (web only). */
export const GET = route(["web"], async () => codexStatus());
export const POST = route(["web"], async () => codexLogin());
