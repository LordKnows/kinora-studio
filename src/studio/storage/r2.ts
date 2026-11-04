import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { config } from "../config";
import { newId } from "../ids";

/* R2 through its S3 API. The browser uploads with a short-lived presigned PUT;
   the RunPod workers write with their own scoped key; the app only ever reads
   public URLs and HEADs objects to confirm a commit. */

let client: S3Client | null = null;

function s3(): S3Client {
  if (client) return client;
  const r2 = config.r2();
  client = new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });
  return client;
}

export function publicUrl(key: string): string {
  return `${config.r2().publicBaseUrl}/${key}`;
}

export function uploadKey(user: string, filename: string): string {
  const safe = filename.replaceAll("\\", "/").split("/").pop()?.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
  const who = user.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60);
  return `uploads/${who}/${newId("up")}-${safe}`;
}

export async function presignPut(key: string, contentType: string, size: number): Promise<{ url: string; expiresAt: number }> {
  const expiresIn = 15 * 60;
  const url = await getSignedUrl(
    s3(),
    new PutObjectCommand({ Bucket: config.r2().bucket, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn },
  );
  return { url, expiresAt: Date.now() + expiresIn * 1000 };
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: config.r2().bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Mirror a platform CDN result into R2 so history outlives the CDN. */
export async function mirrorUrl(sourceUrl: string, key: string, contentType: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok) throw new Error(`mirror fetch failed (${res.status})`);
  const body = new Uint8Array(await res.arrayBuffer());
  await s3().send(new PutObjectCommand({ Bucket: config.r2().bucket, Key: key, Body: body, ContentType: contentType }));
  return publicUrl(key);
}
