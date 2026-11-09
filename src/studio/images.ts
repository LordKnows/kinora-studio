import { config } from "./config";
import { StudioError } from "./errors";
import { checkOnArrival } from "./face-check";
import * as repo from "./repo";
import { nameOfUploadKey, publicUrl, putObject, uploadKey } from "./storage/r2";
import type { Actor, Asset } from "./types";

/* The Studio has no image model. The director (the user's own Claude) often
   does: an image tool in its client, Codex, a hosted model with a URL. This
   is the way in for what it draws — character sheets, hero frames, end
   frames — as ordinary project assets. */

export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

/** Width and height from a PNG, JPEG or WebP header; undefined otherwise. */
export function imageInfo(bytes: Uint8Array): { type: "png" | "jpeg" | "webp"; width: number; height: number } | undefined {
  const b = bytes;
  const u32 = (o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  const u16 = (o: number) => (b[o]! << 8) | b[o + 1]!;
  const le16 = (o: number) => b[o]! | (b[o + 1]! << 8);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "png", width: u32(16), height: u32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const marker = b[o + 1]!;
      const len = u16(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: "jpeg", height: u16(o + 5), width: u16(o + 7) };
      o += 2 + len;
    }
    return undefined;
  }
  if (b.length > 30 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8X") return { type: "webp", width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    if (chunk === "VP8 ") return { type: "webp", width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === "VP8L") { const v = u32le(b, 21); return { type: "webp", width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  return undefined;
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** Store image bytes as a project asset. */
export async function storeImage(projectId: string, bytes: Uint8Array, filename: string, actor: Actor, meta: Record<string, unknown> = {}): Promise<Asset> {
  if (!config.r2Configured()) throw new StudioError("backend_error", "R2 is not configured");
  await repo.getProject(projectId);
  if (bytes.byteLength > MAX_IMPORT_BYTES) throw new StudioError("validation", `image is ${(bytes.byteLength / 1048576).toFixed(1)} MB; the limit is 20 MB`);
  const info = imageInfo(bytes);
  if (!info) throw new StudioError("validation", "not a PNG, JPEG or WebP image");
  const ext = info.type === "jpeg" ? "jpg" : info.type;
  const key = uploadKey(actor.user, filename.includes(".") ? filename : `${filename}.${ext}`);
  await putObject(key, bytes, TYPES[info.type]!);
  const name = typeof meta.label === "string" ? meta.label : nameOfUploadKey(key);
  /* a library picture is 模拟 as it is; anything else gets its face check below */
  const asset = await repo.createAsset({ projectId, url: publicUrl(key), kind: "image", source: "generated", width: info.width, height: info.height, meta: { key, ...meta, ...(meta.reference ? { realness: "sim" } : {}) }, name });
  /* an imported picture is labelled as it arrives (模拟 / 真实), like an upload; library pictures need none */
  return checkOnArrival(asset);
}

/** Fetch an image the director's own tool produced and keep it. */
export async function importImageFromUrl(projectId: string, url: string, actor: Actor, meta: Record<string, unknown> = {}): Promise<Asset> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StudioError("validation", "url is not a URL");
  }
  if (parsed.protocol !== "https:") throw new StudioError("validation", "only https URLs can be imported");
  /* No internal hosts: an import is a server-side fetch. */
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) {
    throw new StudioError("validation", "import from a public hostname, not an IP address or an internal name");
  }
  const res = await fetch(parsed, { redirect: "follow" });
  if (!res.ok) throw new StudioError("validation", `fetching the image failed: HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_IMPORT_BYTES) throw new StudioError("validation", "image is larger than 20 MB");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const name = parsed.pathname.split("/").pop() || "image";
  return storeImage(projectId, bytes, name, actor, { importedFrom: parsed.origin, ...meta });
}

/** A base64 image (data URL or bare), for clients that cannot PUT a file. */
export async function importImageFromBase64(projectId: string, data: string, filename: string, actor: Actor, meta: Record<string, unknown> = {}): Promise<Asset> {
  const b64 = data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new StudioError("validation", "data is not valid base64");
  }
  return storeImage(projectId, bytes, filename, actor, meta);
}
