import { body, route } from "@/api/http";
import * as repo from "@/studio/repo";
import { LookSettings } from "@/studio/schemas";

export const PATCH = route(["web", "mcp"], async (req, { params }) => ({ project: await repo.setProjectLook(params.id!, await body(req, LookSettings.partial())) }));
