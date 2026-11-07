import { route } from "@/api/http";
import { painterPodState } from "@/studio/painter-pod";

/* The painter pod: its settings (Worker vars), the current pod, what it cost. */
export const GET = route(["web", "mcp"], async () => painterPodState());
