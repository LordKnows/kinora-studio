import * as director from "@/director";

import { StudioError } from "./errors";
import * as repo from "./repo";
import type { Actor } from "./types";

/* Styles: the library that ships with the director layer, and the styles the
   users made from it. A project's Look names its style by slug, so a style of
   someone's own resolves for everyone who works on that project; only whoever
   made it can change or delete it. Who made a style stays inside the Studio:
   a listing says "mine" to its maker and "shared" to everyone else, never an
   email. */

/* The picture prompts are built by plain functions; they read a style of
   someone's own from here. `warm` fills it before a picture is drawn. */
const known = new Map<string, director.LoadedStyle>();

/** A style by slug without the database: the library, or a user's style seen since this isolate started. */
export function knownStyle(slug: string | undefined): director.LoadedStyle | undefined {
  if (!slug) return undefined;
  return director.findStyle(slug) ?? known.get(slug);
}

/** Make sure a project's style is in memory before prompts are built from it. */
export async function warm(slug: string | undefined): Promise<void> {
  if (slug && !knownStyle(slug)) await allStyles();
}

/** Every style: the viewer's own first, then the other users' (newest first), then the library. */
export async function allStyles(viewer?: string): Promise<director.LoadedStyle[]> {
  const mine: director.LoadedStyle[] = [];
  for (const row of await repo.listUserStyles()) {
    const parsed = director.StyleSchema.safeParse(row.style);
    /* A style saved under an older schema that no longer parses is left out rather than breaking every listing. */
    if (parsed.success) mine.push({ style: parsed.data, origin: "mine", by: row.user, ...(row.basedOn ? { basedOn: row.basedOn } : {}) });
  }
  known.clear();
  for (const s of mine) known.set(s.style.slug, s);
  const taken = new Set(mine.map((s) => s.style.slug));
  if (viewer) mine.sort((a, b) => Number(b.by === viewer) - Number(a.by === viewer));
  return [...mine, ...director.loadStyles().filter((s) => !taken.has(s.style.slug))];
}

/** By slug, English or Chinese name; the users' own styles included. */
export async function resolveStyle(query: string): Promise<director.LoadedStyle | undefined> {
  return director.findStyle(query, await allStyles());
}

export async function mustResolveStyle(query: string): Promise<director.LoadedStyle> {
  const pool = await allStyles();
  const found = director.findStyle(query, pool);
  if (!found) throw new StudioError("not_found", `no style matches "${query}"`, { available: pool.map((x) => x.style.slug) });
  return found;
}

export type StyleOrigin = "library" | "mine" | "shared";

/** A style as a listing shows it to `viewer`: theirs is "mine", another user's is "shared", and nobody's email is in it. */
export function summary(s: director.LoadedStyle, viewer?: string) {
  const origin: StyleOrigin = s.origin === "library" ? "library" : viewer && s.by === viewer ? "mine" : "shared";
  return { slug: s.style.slug, en: s.style.en, cn: s.style.cn, category: s.style.category, uses: s.style.uses, line: s.style.line, line_cn: s.style.line_cn, origin, ...(s.basedOn ? { basedOn: s.basedOn } : {}) };
}

/** A copy of a style under a new name, with the three groups that say what each change costs. Nothing is stored. */
export async function forkDraft(input: { base: string; slug: string; en: string; cn: string; line?: string; line_cn?: string }) {
  const base = await mustResolveStyle(input.base);
  const draft = director.forkStyle(base.style, input);
  const taken = await takenSlugs();
  const { warnings } = director.checkFork(undefined, draft, taken);
  return {
    basedOn: base.style.slug,
    style: draft,
    groups: director.forkGuide(base.style),
    warnings,
    next: "Plan the changes with the user, one question at a time, your recommendation first: what the films are for, then what to change (show the groups), then section by section. At most five changes a round. Edit this style object and call save_style with basedOn; show the user the changes it returns before they rely on it, and prove the look with generate_style_frame.",
  };
}

async function takenSlugs(user?: string): Promise<{ library: string[]; others: string[] }> {
  return {
    library: director.loadStyles().map((s) => s.style.slug),
    others: (await repo.listUserStyles()).filter((r) => r.user !== user).map((r) => r.slug),
  };
}

/** Keep a style of the user's own. With basedOn, the answer says which sections differ from the base and what that costs. */
export async function saveStyle(actor: Actor, input: { style: unknown; basedOn?: string; why?: Record<string, string> }) {
  const parsed = director.StyleSchema.safeParse(input.style);
  if (!parsed.success) {
    throw new StudioError("validation", `the style does not fit the preset schema: ${parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const style = parsed.data;
  const base = input.basedOn ? (await mustResolveStyle(input.basedOn)).style : undefined;
  if (base && base.slug === style.slug) throw new StudioError("validation", `a style based on ${base.slug} needs a slug of its own`);
  const { warnings } = director.checkFork(base, style, await takenSlugs(actor.user));
  const errors = warnings.filter((w) => w.severity === "error");
  if (errors.length) throw new StudioError("validation", errors.map((w) => w.message).join("; "), { warnings });
  const changes = base ? director.diffStyle(base, style, input.why) : [];
  const row = await repo.putUserStyle({ slug: style.slug, user: actor.user, ...(base ? { basedOn: base.slug } : {}), style, changes });
  return {
    style: summary({ style, origin: "mine", by: row.user, ...(row.basedOn ? { basedOn: row.basedOn } : {}) }, actor.user),
    changes,
    warnings,
    ...(base ? { changesMarkdown: director.changesToMarkdown(base, style, changes) } : {}),
    next: "Name it like any style from now on (compile_look, apply_style_to_project). Show the user the changes and the warnings; a style frame (generate_style_frame) proves the look before a film depends on it.",
  };
}

export async function deleteStyle(actor: Actor, slug: string): Promise<{ deleted: string }> {
  const row = await repo.getUserStyle(slug);
  if (!row) {
    if (director.findStyle(slug)) throw new StudioError("validation", `${slug} is a library style; only a style of your own can be deleted`);
    throw new StudioError("not_found", `no style of your own named "${slug}"`);
  }
  if (row.user !== actor.user) throw new StudioError("forbidden", `${slug} was made by someone else; only they can delete it`);
  await repo.deleteUserStyle(slug);
  return { deleted: slug };
}

/** What changed from the base, as kept with the style. */
export async function styleChanges(slug: string): Promise<{ basedOn?: string; changes: director.StyleChange[] } | undefined> {
  const row = await repo.getUserStyle(slug);
  return row ? { ...(row.basedOn ? { basedOn: row.basedOn } : {}), changes: row.changes as director.StyleChange[] } : undefined;
}
