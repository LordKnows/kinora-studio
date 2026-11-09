import * as repo from "./repo";
import type { Asset } from "./types";

/*
 * Whose face a picture shows, for 18+ work (an 18+ LoRA or reference, in
 * Canvas and in the director's pictures): every face must be AI-generated —
 * never one uploaded or imported, which may be a real person.
 *
 * A face is AI-generated when it is
 *   1. a picture of the reference library (its portraits are AI-generated adults);
 *   2. drawn by the Studio, and every face that went into that drawing is
 *      AI-generated in turn — a picture drawn from text alone qualifies.
 * It is not when it is an upload, a picture imported from a URL or as bytes
 * (the Studio cannot tell where it came from), anything it cannot trace, or
 * a drawing that kept a face from one of those, however many steps back.
 *
 * What went into a drawing is read from its job: the picture it edited or
 * cropped (it keeps its people), and each reference by its role (refRoles,
 * or a Canvas recipe's roles). A face — a portrait, a character's sheet, an
 * extra or unnamed reference — is followed back; an outfit, a pose, a place
 * or a style frame is only borrowed, so an uploaded one does not make the
 * drawing's faces real. A take's frame is followed through the pictures the
 * take was rendered from.
 */

/* the reference library's galleries (references.ts): AI-generated pictures */
const LIBRARY = [
  /^https:\/\/(ai-portrait-gallery|ai-costume-gallery|ai-costume-anime-gallery|charadb-2fi|ai-pose-gallery|ai-pose-depth-gallery)\.pages\.dev\//,
  /^https:\/\/raw\.githubusercontent\.com\/wquguru\/shisei\//,
];

export function isLibraryUrl(url: string): boolean {
  return LIBRARY.some((re) => re.test(url));
}

/* the roles a drawing only borrows from: an uploaded one leaves its faces AI-generated */
const BORROWED = new Set(["outfit", "pose", "scene", "style", "costume", "costume_b"]);

/** Whether a reference of this role puts its face into the drawing (an unknown role does). */
export function isFaceRole(role: string | undefined): boolean {
  return !role || !BORROWED.has(role);
}

const MAX_DEPTH = 8;

type JobInput = {
  refUrls?: string[];
  refRoles?: string[];
  baseUrl?: string;
  videoUrl?: string;
  takeId?: string;
  canvas?: { refs?: Array<{ role?: string; url?: string }> };
};

/** The face-carrying pictures a drawing was made from: its base, and its references but the borrowed ones. */
function facesOf(i: JobInput): string[] {
  const canvasRole = new Map((i.canvas?.refs ?? []).filter((r) => r.url).map((r) => [r.url!, r.role]));
  const refs = (i.refUrls ?? []).filter((u, n) => isFaceRole(i.refRoles?.[n] ?? canvasRole.get(u)));
  return [...refs, i.baseUrl].filter((u): u is string => !!u);
}

/**
 * The first of `urls` (each meant as a face) whose face is not AI-generated, by its name or URL; undefined when
 * every one is. A picture it cannot trace counts as not AI-generated.
 */
export async function firstUploadedFaceIn(projectId: string, urls: Array<string | undefined>): Promise<string | undefined> {
  const assets = await repo.listAssets(projectId);
  const byUrl = new Map(assets.map((a) => [a.url, a]));
  const takes = await repo.listProjectTakes(projectId).catch(() => []);
  const takeOfFrame = new Map(takes.flatMap((t) => [t.lastFrameUrl, t.resultUrl].filter((u): u is string => !!u).map((u) => [u, t] as const)));
  const seen = new Set<string>();
  const label = (a: Asset | undefined, url: string) => a?.handle ?? a?.name ?? url;

  async function realFace(url: string, depth: number): Promise<string | undefined> {
    if (seen.has(url)) return undefined;
    seen.add(url);
    if (isLibraryUrl(url)) return undefined;
    if (depth > MAX_DEPTH) return url;
    const asset = byUrl.get(url);
    const take = !asset ? takeOfFrame.get(url) : undefined;
    if (take) return fromTake(take.id, depth);
    if (!asset) return url;
    if (asset.source === "upload") return label(asset, url);
    /* a library picture brought into the project */
    if (asset.meta.reference) return undefined;
    const jobId = typeof asset.meta.jobId === "string" ? asset.meta.jobId : undefined;
    if (jobId) {
      const job = await repo.getJob(jobId).catch(() => undefined);
      if (!job) return label(asset, url);
      const i = job.input as JobInput;
      /* a frame grabbed from a take shows the take's people */
      if (i.takeId) {
        const bad = await fromTake(i.takeId, depth);
        if (bad) return bad;
      }
      for (const u of facesOf(i)) {
        if (u === i.videoUrl && i.takeId) continue;
        const bad = await realFace(u, depth + 1);
        if (bad) return bad;
      }
      return undefined;
    }
    /* drawn nowhere here: an image imported from a URL or as bytes */
    return label(asset, url);
  }

  async function fromTake(takeId: string, depth: number): Promise<string | undefined> {
    const take = await repo.getTake(takeId).catch(() => undefined);
    if (!take) return `take ${takeId}`;
    const images = (take.input as { images?: Array<{ url?: string }> }).images ?? [];
    for (const img of images) {
      if (!img.url) continue;
      const bad = await realFace(img.url, depth + 1);
      if (bad) return bad;
    }
    return undefined;
  }

  for (const url of urls) {
    if (!url) continue;
    const bad = await realFace(url, 0);
    if (bad) return bad;
  }
  return undefined;
}
