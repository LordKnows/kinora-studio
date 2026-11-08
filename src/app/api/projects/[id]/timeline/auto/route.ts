import { z } from "zod";

import { body, route } from "@/api/http";
import { autoTimeline } from "@/studio/orchestrator";

/* No body: the director's build (selected or latest take, head trims). The web
   Timeline sends { selectedOnly, fullLength }: picked takes only, 0 s to the end. */
const AutoTimelineRequest = z.object({
  selectedOnly: z.boolean().optional(),
  fullLength: z.boolean().optional(),
});

export const POST = route(["web", "mcp"], async (req, { params }) => ({ timeline: await autoTimeline(params.id!, await body(req, AutoTimelineRequest)) }));
