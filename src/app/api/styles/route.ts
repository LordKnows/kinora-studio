import { route } from "@/api/http";
import * as director from "@/director";

/* The style presets of the director layer, as the Brief page lists them. */
export const GET = route(["web", "mcp"], async () => ({
  styles: director.loadStyles().map(({ style: s }) => ({ slug: s.slug, en: s.en, cn: s.cn, category: s.category, uses: s.uses, line: s.line, line_cn: s.line_cn })),
}));
