import { z } from "zod";

import { body, route } from "@/api/http";
import { adultAllowed, setAdultContent } from "@/studio/references";
import * as repo from "@/studio/repo";

/* The signed-in user's preferences. Showing 18+ references is switched on
   here, on the web only, with an explicit adult confirmation. */
export const GET = route(["web", "mcp"], async (_req, { actor }) => {
  const adult = await adultAllowed(actor);
  const s = adult ? await repo.getUserSettings(actor.user) : {};
  return { user: actor.user, adultContent: adult, ...(s.adultContentAt ? { adultContentAt: s.adultContentAt } : {}) };
});

export const PUT = route(["web"], async (req, { actor }) => {
  const input = await body(req, z.object({ adultContent: z.boolean(), confirmAdult: z.boolean().optional() }));
  return { user: actor.user, ...(await setAdultContent(actor, { enabled: input.adultContent, confirmAdult: input.confirmAdult })) };
});
