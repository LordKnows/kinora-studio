import type { PosePicture } from "./canvas-prompt";
import { StudioError } from "./errors";
import { checkPicture } from "./face-check";
import { faceAllowed } from "./face-verdict";
import { imageInfo } from "./images";
import {
  NSFW_COSTUME_CATEGORIES,
  POSE_SYSTEMS,
  REFERENCE_TERMS,
  searchText,
  type CostumeSource,
  type PoseAngle,
  type PoseSystem,
  type RefCostume,
  type RefItem,
  type RefKind,
  type RefPortrait,
  type RefPose,
  MINE_LABEL,
} from "./references-model";
import * as repo from "./repo";
import { getObject, objectExists, publicUrl } from "./storage/r2";
import type { Actor } from "./types";

/*
 * The Canvas reference library: 1,439 poses (line art + depth), 3,224
 * costumes from four sources and 1,499 portraits, with Chinese metadata.
 *
 * Only metadata ships with the Studio. Every picture is referenced on the
 * site that publishes it: the galleries allow using one picture at a time
 * as a generation reference and forbid bulk download and redistribution, so
 * the Studio never mirrors them — a picture is fetched only when it is used
 * (the painter downloads the references of a job; "add to pictures" imports
 * one picture into a project).
 *
 * 18+ material (two pose systems, lingerie and sensual costumes, CharaDB's
 * own flag) is in the catalog but hidden unless the signed-in user has
 * confirmed they are an adult, on the web. The same rule holds for the
 * agent: it sees what its user has unlocked, and cannot unlock it.
 */

type RawCatalog = {
  version: number;
  source: { repository: string; revision: string };
  poses: Array<{ i: string; s: PoseSystem; n: string; c: string; t: string; a: PoseAngle }>;
  costumes: Array<{ i: string; src: CostumeSource; k: "real" | "anime"; c: string; t: string; j?: string; g: string[]; w: string; x?: 1; v?: Array<{ i: string; l: string; th: string; im: string }> }>;
  portraits: Array<{ i: string; s: string; l: string; y: string; t: string; W: number; H: number; p?: 1; o?: 1 }>;
};

type Catalog = { items: RefItem[]; byId: Map<string, RefItem>; text: Map<string, string>; source: RawCatalog["source"] };

const NSFW_SYSTEMS = new Set(POSE_SYSTEMS.filter((s) => s.nsfw).map((s) => s.id));
const NSFW_CATEGORIES = new Set(NSFW_COSTUME_CATEGORIES);

function costumeUrls(src: CostumeSource, id: string): { thumb: string; image: string; original: string } {
  switch (src) {
    case "gia":
      return { thumb: `https://ai-costume-gallery.pages.dev/thumbs/${id}.webp`, image: `https://ai-costume-gallery.pages.dev/img/${id}.webp`, original: `https://ai-costume-gallery.pages.dev/png/${id}.png` };
    case "gia-anime": {
      const k = id.replace(/^gia-anime-/, "");
      return { thumb: `https://ai-costume-anime-gallery.pages.dev/thumbs/${k}.webp`, image: `https://ai-costume-anime-gallery.pages.dev/img/${k}.webp`, original: `https://ai-costume-anime-gallery.pages.dev/png/${k}.png` };
    }
    case "charadb": {
      const k = id.replace(/^charadb-/, "");
      return { thumb: `https://charadb-2fi.pages.dev/thumb/${k}.webp`, image: `https://charadb-2fi.pages.dev/img/${k}.jpg`, original: `https://charadb-2fi.pages.dev/img/${k}.jpg` };
    }
    case "shisei":
    case "mine":
      return { thumb: "", image: "", original: "" };
  }
}

let cached: Promise<Catalog> | null = null;

/* Loaded on first use, through a dynamic import so the bundler keeps one
   shared copy of the ~1 MB catalog instead of one per route. */
function catalog(): Promise<Catalog> {
  cached ??= import("./references-data").then((m) => build(JSON.parse(m.REFERENCE_CATALOG_JSON) as RawCatalog)).catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

function build(raw: RawCatalog): Catalog {
  const poses: RefPose[] = raw.poses.map((p) => ({
    kind: "pose", id: p.i, system: p.s, group: `${p.s}:${p.n}`, number: p.n, category: p.c, name: p.t, angle: p.a, nsfw: NSFW_SYSTEMS.has(p.s),
    thumb: `https://ai-pose-gallery.pages.dev/thumbs/${p.i}.jpg`, image: `https://ai-pose-gallery.pages.dev/img/${p.i}.png`,
    depthThumb: `https://ai-pose-depth-gallery.pages.dev/thumbs/${p.i}.jpg`, depthImage: `https://ai-pose-depth-gallery.pages.dev/img/${p.i}.png`,
  }));
  const costumes: RefCostume[] = raw.costumes.map((c) => {
    const views = c.v?.map((v) => ({ id: v.i, label: v.l, thumb: v.th, image: v.im }));
    const front = views?.find((v) => v.id === "front") ?? views?.[0];
    const urls = front ? { thumb: front.thumb, image: front.image, original: front.image } : costumeUrls(c.src, c.i);
    return {
      kind: "costume", id: c.i, source: c.src, style: c.k, category: c.c, name: c.t, ...(c.j ? { nameJa: c.j } : {}), tags: c.g, keywords: c.w,
      nsfw: c.x === 1 || NSFW_CATEGORIES.has(c.c), ...urls, ...(views?.length ? { views } : {}),
    };
  });
  const portraits: RefPortrait[] = raw.portraits.map((p) => ({
    kind: "portrait", id: p.i, section: p.s, hairLength: p.l, hairstyle: p.y, title: p.t, width: p.W, height: p.H, featured: p.p === 1, hot: p.o === 1, nsfw: false,
    thumb: `https://ai-portrait-gallery.pages.dev/img/thumb/${p.i}.webp`, image: `https://ai-portrait-gallery.pages.dev/img/full/${p.i}.png`,
  }));
  const items: RefItem[] = [...portraits, ...costumes, ...poses];
  return { items, byId: new Map(items.map((x) => [x.id, x])), text: new Map(items.map((x) => [x.id, searchText(x)])), source: raw.source };
}

/* ---------- the 18+ gate ---------- */

/** Whether this caller may see 18+ references: its user confirmed being an adult on the web. */
export async function adultAllowed(actor: Actor): Promise<boolean> {
  if (actor.user === "anonymous" || actor.user === "mcp-static") return false;
  const s = await repo.getUserSettings(actor.user);
  return typeof s.adultContentAt === "number";
}

/** Switch 18+ references on or off for the signed-in user. Web only, and switching on needs the adult confirmation. */
export async function setAdultContent(actor: Actor, input: { enabled: boolean; confirmAdult?: boolean }): Promise<{ adultContent: boolean; adultContentAt?: number }> {
  if (actor.via !== "web") throw new StudioError("forbidden", "18+ references are switched on by the user on the Canvas page (web only)");
  if (input.enabled && input.confirmAdult !== true) throw new StudioError("validation", "confirm that you are 18 or older to show 18+ references");
  const s = await repo.setUserSettings(actor.user, { adultContentAt: input.enabled ? Date.now() : null });
  return { adultContent: typeof s.adultContentAt === "number", ...(typeof s.adultContentAt === "number" ? { adultContentAt: s.adultContentAt } : {}) };
}

/* ---------- reading ---------- */

export type ReferenceQuery = {
  kind?: RefKind;
  q?: string;
  category?: string;
  source?: CostumeSource;
  style?: "real" | "anime";
  system?: PoseSystem;
  angle?: PoseAngle;
  section?: string;
  hairLength?: string;
  hot?: boolean;
  page?: number;
  pageSize?: number;
};

function matches(item: RefItem, q: ReferenceQuery, text: string): boolean {
  if (q.kind && item.kind !== q.kind) return false;
  if (q.category && (item.kind === "portrait" ? item.hairstyle : item.category) !== q.category) return false;
  if (item.kind === "costume" && ((q.source && item.source !== q.source) || (q.style && item.style !== q.style))) return false;
  if (item.kind === "pose" && ((q.system && item.system !== q.system) || (q.angle && item.angle !== q.angle))) return false;
  if (item.kind === "portrait" && ((q.section && item.section !== q.section) || (q.hairLength && item.hairLength !== q.hairLength) || (q.hot && !item.hot))) return false;
  if (q.q) {
    const words = q.q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.every((w) => text.includes(w))) return false;
  }
  return true;
}

/** Every item of a kind the caller may see (the user's own first), and how many 18+ items were left out. */
export async function listReferences(kind: RefKind, adult: boolean, user?: string): Promise<{ items: RefItem[]; hidden: number }> {
  const all = (await catalog()).items.filter((x) => x.kind === kind);
  const items = adult ? all : all.filter((x) => !x.nsfw);
  const mine = user ? (await myItems(user)).filter((x) => x.kind === kind) : [];
  return { items: [...mine, ...items], hidden: all.length - items.length };
}

/** A page of matching items (the agent's view, and search). */
export async function queryReferences(q: ReferenceQuery, adult: boolean, user?: string): Promise<{ items: RefItem[]; total: number; page: number; pageSize: number; hidden: number }> {
  const c = await catalog();
  const pageSize = Math.max(1, Math.min(100, q.pageSize ?? 20));
  const page = Math.max(1, q.page ?? 1);
  let hidden = 0;
  const hits: RefItem[] = [];
  const mine = user ? await myItems(user) : [];
  for (const item of [...mine, ...c.items]) {
    if (!matches(item, q, item.mine ? searchText(item) : c.text.get(item.id) ?? "")) continue;
    if (item.nsfw && !adult) {
      hidden++;
      continue;
    }
    hits.push(item);
  }
  return { items: hits.slice((page - 1) * pageSize, page * pageSize), total: hits.length, page, pageSize, hidden };
}

/** One item; an 18+ item answers forbidden until the user has unlocked them. A 我的 item only for its owner. */
export async function getReference(id: string, adult: boolean, user?: string): Promise<RefItem> {
  if (id.startsWith(MINE_PREFIX)) {
    const row = await repo.getUserReference(id.slice(MINE_PREFIX.length));
    if (!row || row.user !== user) throw new StudioError("not_found", `no reference ${id}`);
    return mineItem(row);
  }
  const item = (await catalog()).byId.get(id);
  if (!item) throw new StudioError("not_found", `no reference ${id}`);
  if (item.nsfw && !adult) throw new StudioError("forbidden", "this reference is 18+; the user shows 18+ references on the Canvas page (web only)", { adult: false });
  return item;
}

export async function referenceSummary(): Promise<{ counts: Record<RefKind, number>; nsfw: Record<RefKind, number>; source: RawCatalog["source"]; terms: typeof REFERENCE_TERMS }> {
  const c = await catalog();
  const counts = { pose: 0, costume: 0, portrait: 0 } as Record<RefKind, number>;
  const nsfw = { pose: 0, costume: 0, portrait: 0 } as Record<RefKind, number>;
  for (const x of c.items) {
    counts[x.kind]++;
    if (x.nsfw) nsfw[x.kind]++;
  }
  return { counts, nsfw, source: c.source, terms: REFERENCE_TERMS };
}

/* ---------- 我的: the user's own pictures ---------- */

const MINE_PREFIX = "mine-";
export const MY_TAGS_MAX = 12;

/** A user's own picture as a library item: listed under 我的, its URL our own (R2). */
export function mineItem(r: repo.UserReference): RefItem {
  const mine = {
    tags: r.tags, createdAt: r.createdAt,
    ...(r.picture ? { picture: r.picture as PosePicture } : {}),
    ...(r.meta.faceCheck ? { faceCheck: r.meta.faceCheck as NonNullable<RefPortrait["mine"]>["faceCheck"] } : {}),
    ...(r.meta.faceCheckError ? { faceCheckError: r.meta.faceCheckError as { why?: string } } : {}),
  };
  const id = `${MINE_PREFIX}${r.id}`;
  if (r.kind === "portrait") {
    return { kind: "portrait", id, section: MINE_LABEL, hairLength: "", hairstyle: MINE_LABEL, title: r.name, width: r.width ?? 0, height: r.height ?? 0, featured: false, hot: false, nsfw: false, thumb: r.url, image: r.url, mine };
  }
  if (r.kind === "costume") {
    return { kind: "costume", id, source: "mine", style: "real", category: MINE_LABEL, name: r.name, tags: r.tags, keywords: "", nsfw: false, thumb: r.url, image: r.url, original: r.url, mine };
  }
  return { kind: "pose", id, system: "mine", group: id, number: "", category: MINE_LABEL, name: r.name, angle: "front", nsfw: false, thumb: r.url, image: r.url, depthThumb: r.url, depthImage: r.url, mine };
}

async function myItems(user: string): Promise<RefItem[]> {
  return (await repo.listUserReferences(user).catch(() => [])).map(mineItem);
}

/** The user's own pictures, newest first. */
export async function listMyReferences(actor: Actor): Promise<RefItem[]> {
  return myItems(actor.user);
}

async function ownRow(actor: Actor, id: string): Promise<repo.UserReference> {
  const row = await repo.getUserReference(id.startsWith(MINE_PREFIX) ? id.slice(MINE_PREFIX.length) : id);
  if (!row || row.user !== actor.user) throw new StudioError("not_found", `no reference ${id} of yours`);
  return row;
}

function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 30)))].slice(0, MY_TAGS_MAX);
}

/**
 * Add a picture the browser put in R2 (presign → PUT) to the user's library. A portrait gets its face check now
 * (模拟 / 真实, the only time a model looks); a costume or a pose gets none.
 */
export async function addMyReference(actor: Actor, input: { key: string; kind: RefKind; name: string; tags?: string[]; picture?: PosePicture }): Promise<RefItem> {
  if (actor.user === "anonymous" || actor.user === "mcp-static") throw new StudioError("forbidden", "sign in to keep pictures of your own");
  if (!input.key.startsWith("uploads/")) throw new StudioError("validation", "key must be under uploads/");
  if (!(await objectExists(input.key))) throw new StudioError("validation", "object not found in the bucket; upload first");
  let size: { width?: number; height?: number } = {};
  try {
    const head = await getObject(input.key, "bytes=0-131071");
    const info = head.ok ? imageInfo(new Uint8Array(await head.arrayBuffer())) : undefined;
    if (info) size = { width: info.width, height: info.height };
  } catch {
    /* the size is a nicety */
  }
  const url = publicUrl(input.key);
  let meta: Record<string, unknown> = {};
  if (input.kind === "portrait") {
    const { verdict, why } = await checkPicture({ url, key: input.key });
    meta = verdict ? { faceCheck: verdict, realness: faceAllowed(verdict) ? "sim" : "real" } : { realness: "real", faceCheckError: { why: why ?? "no verdict", at: Date.now() } };
  }
  const row = await repo.createUserReference({
    user: actor.user, kind: input.kind, name: input.name.trim().slice(0, 60) || "my picture", tags: cleanTags(input.tags), url, key: input.key, ...size,
    ...(input.kind === "pose" ? { picture: input.picture ?? "photo" } : {}), meta,
  });
  return mineItem(row);
}

/** Rename, retag, or (a pose) say again what its picture is. */
export async function updateMyReference(actor: Actor, id: string, patch: { name?: string; tags?: string[]; picture?: PosePicture }): Promise<RefItem> {
  const row = await ownRow(actor, id);
  return mineItem(await repo.updateUserReference(row.id, {
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 60) || row.name } : {}),
    ...(patch.tags !== undefined ? { tags: cleanTags(patch.tags) } : {}),
    ...(patch.picture && row.kind === "pose" ? { picture: patch.picture } : {}),
  }));
}

/** Take a picture out of the user's library. Pictures already drawn from it keep their copies. */
export async function deleteMyReference(actor: Actor, id: string): Promise<void> {
  const row = await ownRow(actor, id);
  await repo.deleteUserReference(row.id);
}

/** Run a portrait's face check again. */
export async function recheckMyReference(actor: Actor, id: string): Promise<RefItem> {
  const row = await ownRow(actor, id);
  if (row.kind !== "portrait") throw new StudioError("validation", "only portraits get a face check");
  const { verdict, why } = await checkPicture({ url: row.url, key: row.key });
  const meta = verdict ? { faceCheck: verdict, realness: faceAllowed(verdict) ? "sim" : "real" } : { ...row.meta, realness: "real", faceCheckError: { why: why ?? "no verdict", at: Date.now() } };
  return mineItem(await repo.updateUserReference(row.id, { meta }));
}
