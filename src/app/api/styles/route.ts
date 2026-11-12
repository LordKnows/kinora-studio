import { route } from "@/api/http";
import * as styles from "@/studio/styles";

/* The styles of the director layer, as the Brief page lists them: the viewer's own first, then other users', then the library. */
export const GET = route(["web", "mcp"], async (_req, { actor }) => ({
  styles: (await styles.allStyles(actor.user)).map((s) => styles.summary(s, actor.user)),
}));
