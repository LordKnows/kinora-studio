import { NextResponse } from "next/server";

import { config } from "@/studio/config";
import { getObject } from "@/studio/storage/r2";

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

async function fromS3(key: string, range: string | null): Promise<Response> {
  if (!config.r2Configured()) return NextResponse.json({ error: { code: "backend_error", message: "R2 is not configured" } }, { status: 500 });
  const res = await getObject(key, range);
  if (res.status === 404) return NextResponse.json({ error: { code: "not_found", message: "no such object" } }, { status: 404 });
  if (!res.ok && res.status !== 206) return NextResponse.json({ error: { code: "backend_error", message: `storage answered ${res.status}` } }, { status: 502 });
  const headers = new Headers({ "accept-ranges": "bytes", "cache-control": "public, max-age=31536000, immutable" });
  for (const name of ["content-type", "content-length", "content-range", "etag"]) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new Response(res.body, { status: res.status, headers });
}
