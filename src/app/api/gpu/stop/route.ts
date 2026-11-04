import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

export const POST = route(["web", "mcp"], async () => gpu.stopGpu());
