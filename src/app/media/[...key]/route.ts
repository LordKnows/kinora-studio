import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";

import { config } from "@/studio/config";

/* Serves bucket objects under the studio's own hostname, so one subdomain
   carries both the app and the media. On Workers it reads through the R2
   binding (no egress fee, Range supported); on Node it proxies the S3 API.
   Keys are unguessable ids, which is the access control for this path. */

const ALLOWED_PREFIXES = ["uploads/", "projects/"];

export async function GET(req: Request, ctx: { params: Promise<{ key: string[] }> }): Promise<Response> {
  const { key: parts } = await ctx.params;
  const key = parts.map(decodeURIComponent).join("/");
  if (key.includes("..") || !ALLOWED_PREFIXES.some((p) => key.startsWith(p))) {
    return NextResponse.json({ error: { code: "not_found", message: "no such object" } }, { status: 404 });
  }
  const range = req.headers.get("range");
  return process.env.STUDIO_DB === "d1" ? fromBinding(key, req.headers) : fromS3(key, range);
}

async function fromBinding(key: string, headers: Headers): Promise<Response> {
  const { bindR2 } = await import("@/cloudflare");
  const bucket = await bindR2();
  if (!bucket) return NextResponse.json({ error: { code: "backend_error", message: "no R2 binding" } }, { status: 500 });
  const partial = headers.has("range");
  const object = await bucket.get(key, partial ? { range: headers } : undefined);
  if (!object) return NextResponse.json({ error: { code: "not_found", message: "no such object" } }, { status: 404 });
  const out = new Headers();
  object.writeHttpMetadata(out);
  out.set("etag", object.httpEtag);
  out.set("accept-ranges", "bytes");
  out.set("cache-control", "public, max-age=31536000, immutable");
  if (partial && object.range && typeof object.range.offset === "number") {
    const start = object.range.offset;
    const length = object.range.length ?? object.size - start;
    out.set("content-range", `bytes ${start}-${start + length - 1}/${object.size}`);
    out.set("content-length", String(length));
    return new Response(object.body, { status: 206, headers: out });
  }
  out.set("content-length", String(object.size));
  return new Response(object.body, { status: 200, headers: out });
}

let s3: S3Client | null = null;

async function fromS3(key: string, range: string | null): Promise<Response> {
  if (!config.r2Configured()) return NextResponse.json({ error: { code: "backend_error", message: "R2 is not configured" } }, { status: 500 });
  const r2 = config.r2();
  s3 ??= new S3Client({
    region: "auto",
    endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
  });
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key, ...(range ? { Range: range } : {}) }));
    const headers = new Headers({ "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable" });
    if (obj.ContentType) headers.set("content-type", obj.ContentType);
    if (obj.ContentLength !== undefined) headers.set("content-length", String(obj.ContentLength));
    if (obj.ContentRange) headers.set("content-range", obj.ContentRange);
    if (obj.ETag) headers.set("etag", obj.ETag);
    const body = obj.Body ? (obj.Body as { transformToWebStream(): ReadableStream<Uint8Array> }).transformToWebStream() : null;
    return new Response(body, { status: obj.ContentRange ? 206 : 200, headers });
  } catch (caught) {
    const status = (caught as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404 || (caught as { name?: string }).name === "NoSuchKey") {
      return NextResponse.json({ error: { code: "not_found", message: "no such object" } }, { status: 404 });
    }
    throw caught;
  }
}
