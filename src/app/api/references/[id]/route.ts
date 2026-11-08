import { route } from "@/api/http";
import { adultAllowed, getReference } from "@/studio/references";

/* One reference by id. An 18+ item answers forbidden until the user has unlocked them. */
export const GET = route(["web", "mcp"], async (_req, { params, actor }) => ({ item: await getReference(params.id!, await adultAllowed(actor)) }));
