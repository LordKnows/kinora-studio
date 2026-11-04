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
