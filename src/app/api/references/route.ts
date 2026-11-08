import { z } from "zod";

import { noStore, route } from "@/api/http";
import { adultAllowed, listReferences, queryReferences, referenceSummary } from "@/studio/references";

/* The Canvas reference library. `?kind=pose|costume|portrait` alone answers
   every item of that kind the caller may see (the Canvas page filters in the
   browser); with `page` or any filter it answers one page of matches. 18+
   items are left out until the user unlocks them on the web. */

const Query = z.object({
  kind: z.enum(["pose", "costume", "portrait"]).optional(),
  q: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  source: z.enum(["gia", "gia-anime", "charadb", "shisei"]).optional(),
  style: z.enum(["real", "anime"]).optional(),
  system: z.enum(["standard", "sensual", "upper", "couple"]).optional(),
  angle: z.enum(["front", "diag", "side", "high", "low"]).optional(),
  section: z.string().max(40).optional(),
  hairLength: z.string().max(40).optional(),
  hot: z.enum(["1", "true"]).optional(),
  page: z.coerce.number().int().min(1).max(10000).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const GET = route(["web", "mcp"], async (req, { actor }) => {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const q = Query.parse(params);
  const adult = await adultAllowed(actor);
  const filtered = Object.keys(params).some((k) => k !== "kind");
  if (!q.kind && !filtered) return { ...(await referenceSummary()), adult };
  if (q.kind && !filtered) return Response.json({ kind: q.kind, adult, ...(await listReferences(q.kind, adult)) }, noStore);
  return { adult, ...(await queryReferences({ ...q, hot: q.hot ? true : undefined }, adult)) };
});
