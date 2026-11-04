import { route } from "@/api/http";
import * as gpu from "@/studio/gpu";

export const GET = route(["web", "mcp"], async () => ({ types: await gpu.listGpuTypes() }));
