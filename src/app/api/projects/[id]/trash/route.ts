import { route } from "@/api/http";
import * as trash from "@/studio/trash";

/* What was deleted in this project and can still be put back (the Director page). */
export const GET = route(["web"], async (_req, { params }) => ({ trash: await trash.listForProject(params.id!), days: trash.TRASH_DAYS }));
