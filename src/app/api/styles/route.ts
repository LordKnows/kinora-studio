import { route } from "@/api/http";
import * as styles from "@/studio/styles";

/* The styles of the director layer, as the Brief page lists them: the users' own first, then the library. */
export const GET = route(["web", "mcp"], async () => ({
  styles: (await styles.allStyles()).map(styles.summary),
}));
