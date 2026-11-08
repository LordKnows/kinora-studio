import { AwsClient } from "aws4fetch";

import { config } from "../config";
import { newId } from "../ids";

/* R2 through its S3 API, signed with aws4fetch: pure fetch + WebCrypto, so the
   same code runs on Workers and Node (the AWS SDK reads ~/.aws files and
   breaks on Workers). The browser uploads with a short-lived presigned PUT;
   the RunPod workers write with their own scoped key; the app reads public
   URLs and HEADs objects to confirm a commit. */

let client: AwsClient | null = null;

function s3(): AwsClient {
  if (client) return client;
  const r2 = config.r2();
  client = new AwsClient({ accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey, service: "s3", region: "auto" });
  return client;
}

export function objectUrl(key: string): string {
  const r2 = config.r2();
  return `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export function publicUrl(key: string): string {
  return `${config.r2().publicBaseUrl}/${key}`;
}

export function uploadKey(user: string, filename: string): string {
  const safe = filename.replaceAll("\\", "/").split("/").pop()?.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
  const who = user.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return `uploads/${who}/${newId("up")}-${safe}`;
}

const PRESIGN_SECONDS = 15 * 60;

/** A presigned PUT. Only the host is signed, so the browser is free to send
    its own Content-Type; the key itself is unguessable. */
export async function presignPut(key: string, _contentType: string, _size: number): Promise<{ url: string; expiresAt: number }> {
  const url = new URL(objectUrl(key));
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_SECONDS));
  const signed = await s3().sign(new Request(url, { method: "PUT" }), { aws: { signQuery: true } });
  return { url: signed.url, expiresAt: Date.now() + PRESIGN_SECONDS * 1000 };
}

export async function objectExists(key: string): Promise<boolean> {
  const res = await s3().fetch(objectUrl(key), { method: "HEAD" });
  return res.ok;
}

/** Signed GET for the Node side of /media (Workers use the binding). */
export async function getObject(key: string, range?: string | null): Promise<Response> {
  return s3().fetch(objectUrl(key), { method: "GET", headers: range ? { range } : {} });
}

/** Server-side write (an image the director imports by URL or as base64). */
export async function putObject(key: string, body: ArrayBuffer | Uint8Array, contentType: string): Promise<void> {
  const res = await s3().fetch(objectUrl(key), { method: "PUT", body: body as BodyInit, headers: { "content-type": contentType } });
  if (!res.ok) throw new Error(`R2 PUT ${key} failed: ${res.status} ${await res.text().catch(() => "")}`);
}

/** A readable name from an upload key: the file name the user chose, without our prefix and extension. */
export function nameOfUploadKey(key: string): string | undefined {
  const file = key.split("/").pop() ?? "";
  return file.replace(/^up_[A-Za-z0-9]+-/, "").replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/[_-]+/g, " ").trim() || undefined;
}

/** Remove an object (a deleted picture and its preview). A missing key is not an error. */
export async function deleteObject(key: string): Promise<void> {
  const res = await s3().fetch(objectUrl(key), { method: "DELETE" });
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} failed: ${res.status}`);
}

/** The R2 key behind one of our public URLs, or undefined for anything else. */
export function keyOfPublicUrl(url: string): string | undefined {
  const base = `${config.r2().publicBaseUrl}/`;
  return url.startsWith(base) ? decodeURIComponent(url.slice(base.length).split("?")[0]!) : undefined;
}
