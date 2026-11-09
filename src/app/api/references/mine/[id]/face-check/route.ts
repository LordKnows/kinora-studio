import { route } from "@/api/http";
import { recheckMyReference } from "@/studio/references";

/* Run one of the user's own portraits through the face check again (模拟 / 真实). */
export const POST = route(["web"], async (_req, { params, actor }) => ({ item: await recheckMyReference(actor, params.id!) }));
