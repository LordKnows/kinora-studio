/* Glue for Workers: expose the D1 and R2 bindings to the app. Imported only
   when STUDIO_DB=d1 (see src/db/index.ts and src/app/media). */

export type R2ObjectLike = {
  size: number;
  httpEtag: string;
  body: ReadableStream<Uint8Array>;
  range?: { offset?: number; length?: number; suffix?: number };
  writeHttpMetadata(headers: Headers): void;
};

export type R2BucketLike = {
  get(key: string, options?: { range?: Headers }): Promise<R2ObjectLike | null>;
};

type Env = { DB?: unknown; TAKES?: R2BucketLike };

async function env(): Promise<Env> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  return (getCloudflareContext() as { env: Env }).env;
}

export async function bindD1(): Promise<unknown | null> {
  return (await env()).DB ?? null;
}

export async function bindR2(): Promise<R2BucketLike | null> {
  return (await env()).TAKES ?? null;
}
