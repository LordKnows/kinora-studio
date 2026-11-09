import * as repo from "./repo";
import type { Asset } from "./types";

/*
 * Where a picture comes from, for LoRAs made for adult content (Canvas and
 * the director's pictures keep the same rule): such a LoRA draws only from
 * the Studio's own pictures and the reference library (AI-generated adults),
 * never from anything uploaded or imported — that may be a real person. A
 * picture the Studio drew is traced back through the job that drew it (its
 * references and the picture it edited) and a take's frame through the take
 * (the pictures it was rendered from), so a likeness taken from an upload is
 * found however many steps it went through.
 */

/* the reference library's galleries (references.ts): AI-generated pictures */
const LIBRARY = [
  /^https:\/\/(ai-portrait-gallery|ai-costume-gallery|ai-costume-anime-gallery|charadb-2fi|ai-pose-gallery|ai-pose-depth-gallery)\.pages\.dev\//,
  /^https:\/\/raw\.githubusercontent\.com\/wquguru\/shisei\//,
];

export function isLibraryUrl(url: string): boolean {
  return LIBRARY.some((re) => re.test(url));
}

const MAX_DEPTH = 8;

/** The first of `urls` that is, or was drawn from, an uploaded or imported picture (its name or URL); undefined when every one is the Studio's own or the library's. A picture it cannot trace counts as uploaded. */
export async function firstUploadIn(projectId: string, urls: Array<string | undefined>): Promise<string | undefined> {
  const assets = await repo.listAssets(projectId);
  const byUrl = new Map(assets.map((a) => [a.url, a]));
  const takes = await repo.listProjectTakes(projectId).catch(() => []);
  const takeOfFrame = new Map(takes.flatMap((t) => [t.lastFrameUrl, t.resultUrl].filter((u): u is string => !!u).map((u) => [u, t] as const)));
  const seen = new Set<string>();
  const label = (a: Asset | undefined, url: string) => a?.handle ?? a?.name ?? url;

  async function tainted(url: string, depth: number): Promise<string | undefined> {
    if (seen.has(url)) return undefined;
    seen.add(url);
    if (isLibraryUrl(url)) return undefined;
    if (depth > MAX_DEPTH) return url;
    const asset = byUrl.get(url);
    const take = !asset ? takeOfFrame.get(url) : undefined;
    if (take) return fromTake(take.id, depth);
    if (!asset) return url;
    if (asset.source === "upload") return label(asset, url);
    if (asset.meta.reference) return undefined;
    const jobId = typeof asset.meta.jobId === "string" ? asset.meta.jobId : undefined;
    if (jobId) {
      const job = await repo.getJob(jobId).catch(() => undefined);
      if (!job) return label(asset, url);
      const i = job.input as { refUrls?: string[]; baseUrl?: string; videoUrl?: string; takeId?: string };
      if (i.takeId) {
        const bad = await fromTake(i.takeId, depth);
        if (bad) return bad;
      }
      for (const u of [...(i.refUrls ?? []), i.baseUrl, i.videoUrl].filter((x): x is string => !!x)) {
        if (u === i.videoUrl && i.takeId) continue;
        const bad = await tainted(u, depth + 1);
        if (bad) return bad;
      }
      return undefined;
    }
    /* drawn nowhere here: an image the director imported from a URL or as bytes */
    return label(asset, url);
  }

  async function fromTake(takeId: string, depth: number): Promise<string | undefined> {
    const take = await repo.getTake(takeId).catch(() => undefined);
    if (!take) return `take ${takeId}`;
    const images = (take.input as { images?: Array<{ url?: string }> }).images ?? [];
    for (const img of images) {
      if (!img.url) continue;
      const bad = await tainted(img.url, depth + 1);
      if (bad) return bad;
    }
    return undefined;
  }

  for (const url of urls) {
    if (!url) continue;
    const bad = await tainted(url, 0);
    if (bad) return bad;
  }
  return undefined;
}
