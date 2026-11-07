import { config } from "./config";
import { getObject } from "./storage/r2";

/* Pictures as MCP image content, so the director (or a fresh reviewer)
   actually sees a frame instead of reading its URL. Bytes come from R2 by key
   when the URL is ours (no round trip through Access), else by fetch. */

export const MAX_IMAGE_BYTES = 1_500_000;

export type ImageBlock = { type: "image"; data: string; mimeType: string };

function keyOf(url: string): string | undefined {
  try {
    const base = config.r2().publicBaseUrl.replace(/\/$/, "");
    return url.startsWith(`${base}/`) ? decodeURIComponent(url.slice(base.length + 1).split("?")[0]!) : undefined;
  } catch {
    return undefined;
  }
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function mimeOf(bytes: Uint8Array, url: string): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  return /\.png(\?|$)/i.test(url) ? "image/png" : "image/jpeg";
}

/** One picture as an image block, or why it could not be included. */
export async function imageBlock(url: string): Promise<ImageBlock | { error: string }> {
  try {
    const key = keyOf(url);
    const res = key ? await getObject(key) : await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_IMAGE_BYTES) return { error: `${(bytes.byteLength / 1e6).toFixed(1)} MB is too large to inline; open the url` };
    return { type: "image", data: toBase64(bytes), mimeType: mimeOf(bytes, url) };
  } catch (caught) {
    return { error: caught instanceof Error ? caught.message : String(caught) };
  }
}
