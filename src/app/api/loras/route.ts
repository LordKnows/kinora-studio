import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { LoraInput } from "@/studio/schemas";

/* The global LoRA library: files that live in the pod's models/loras, with
   their HuggingFace source so the pod can fetch a missing one. */
export const GET = route(["web", "mcp"], async () => ({ loras: await repo.listLoras() }));

export const POST = route(["web", "mcp"], async (req) => ({ lora: await repo.createLora(await body(req, LoraInput)) }));
