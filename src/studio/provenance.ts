import { describeVerdict, faceAllowed, type FaceVerdict } from "./face-verdict";
import * as repo from "./repo";
import type { Asset } from "./types";

/*
 * 模拟 or 真实: whether a picture may show a real person. Only 模拟 pictures go
 * into R18 work (an 18+ LoRA or reference, in Canvas and the director's
 * pictures).
 *
 *  - An upload or an import: its face check, made once as it arrived — the
 *    only time a model looks (face-check.ts). 模拟 when it found a 3D
 *    render, an illustration or no face; 真实 otherwise, and when it has no
 *    check.
 *  - The reference library: 模拟.
 *  - A picture the Studio drew: 真实 as soon as any picture it was drawn
 *    from is 真实 — a reference, the picture it edited or cropped, the take
 *    a frame was grabbed from (through the take's own pictures) — however
 *    far back; 模拟 otherwise, text to image included. No model is asked.
 *
 * A picture it cannot trace counts as 真实.
 */

export type Realness = "sim" | "real";

/* the reference library's galleries (references.ts): AI-generated pictures */
const LIBRARY = [
  /^https:\/\/(ai-portrait-gallery|ai-costume-gallery|ai-costume-anime-gallery|charadb-2fi|ai-pose-gallery|ai-pose-depth-gallery)\.pages\.dev\//,
  /^https:\/\/raw\.githubusercontent\.com\/wquguru\/shisei\//,
];

export function isLibraryUrl(url: string): boolean {
  return LIBRARY.some((re) => re.test(url));
}

const MAX_DEPTH = 8;

type JobInput = { refUrls?: string[]; baseUrl?: string; videoUrl?: string; takeId?: string };

/** The pictures a drawing was made from: every reference and the picture it edits or crops. */
export function inputsOf(i: JobInput): string[] {
  return [...(i.refUrls ?? []), i.baseUrl].filter((u): u is string => !!u && u !== i.videoUrl);
}

/** An upload or an import is 模拟 when its face check says so. */
export function outsideRealness(a: Asset): Realness {
  return faceAllowed(a.meta.faceCheck as FaceVerdict | undefined) ? "sim" : "real";
}

/**
 * The first of `urls` that is 真实, by its name or URL (with why); undefined when every one is 模拟. A drawing is
 * named by the 真实 picture it came from.
 */
export async function firstRealIn(projectId: string, urls: Array<string | undefined>, opts: { takeId?: string } = {}): Promise<string | undefined> {
  const assets = await repo.listAssets(projectId);
  const byUrl = new Map(assets.map((a) => [a.url, a]));
  const takes = await repo.listProjectTakes(projectId).catch(() => []);
  const takeOfFrame = new Map(takes.flatMap((t) => [t.lastFrameUrl, t.resultUrl].filter((u): u is string => !!u).map((u) => [u, t] as const)));
  const seen = new Set<string>();
  const label = (a: Asset | undefined, url: string) => a?.handle ?? a?.name ?? url;

  async function real(url: string, depth: number): Promise<string | undefined> {
    if (seen.has(url)) return undefined;
    seen.add(url);
    if (isLibraryUrl(url)) return undefined;
    if (depth > MAX_DEPTH) return url;
    const asset = byUrl.get(url);
    /* a library picture brought into the project */
    if (asset?.meta.reference) return undefined;
    /* a take's frame shows the take's people */
    const frameTake = asset?.source === "frame-extract" ? (typeof asset.meta.takeId === "string" ? asset.meta.takeId : takeOfFrame.get(url)?.id) : !asset ? takeOfFrame.get(url)?.id : undefined;
    if (frameTake && !asset?.meta.jobId) return fromTake(frameTake, depth);
    if (!asset) return `${url} (真实: not a picture of this project)`;
    const jobId = typeof asset.meta.jobId === "string" ? asset.meta.jobId : undefined;
    if (asset.source === "upload" || !jobId) {
      /* an upload or an import: its face check, made as it arrived */
      const v = asset.meta.faceCheck as FaceVerdict | undefined;
      return faceAllowed(v) ? undefined : `${label(asset, url)} (真实: ${describeVerdict(v).replace(/^face check: /, "")})`;
    }
    const job = await repo.getJob(jobId).catch(() => undefined);
    if (!job) return `${label(asset, url)} (真实: its drawing cannot be traced)`;
    const i = job.input as JobInput;
    if (i.takeId) {
      const bad = await fromTake(i.takeId, depth);
      if (bad) return bad;
    }
    for (const u of inputsOf(i)) {
      const bad = await real(u, depth + 1);
      if (bad) return bad;
    }
    return undefined;
  }

  async function fromTake(takeId: string, depth: number): Promise<string | undefined> {
    const take = await repo.getTake(takeId).catch(() => undefined);
    if (!take) return `take ${takeId} (真实: cannot be traced)`;
    const images = (take.input as { images?: Array<{ url?: string }> }).images ?? [];
    for (const img of images) {
      if (!img.url) continue;
      const bad = await real(img.url, depth + 1);
      if (bad) return bad;
    }
    return undefined;
  }

  if (opts.takeId) {
    const bad = await fromTake(opts.takeId, 0);
    if (bad) return bad;
  }
  for (const url of urls) {
    if (!url) continue;
    const bad = await real(url, 0);
    if (bad) return bad;
  }
  return undefined;
}

/** 模拟 or 真实 for a drawing about to be kept: from the pictures it was made from (none: text to image, 模拟). */
export async function realnessOfDrawing(projectId: string, input: JobInput): Promise<Realness> {
  return (await firstRealIn(projectId, inputsOf(input), { takeId: input.takeId }).catch(() => "unknown")) ? "real" : "sim";
}
