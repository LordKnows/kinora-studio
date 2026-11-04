/* Glue for Workers: expose the D1 binding to the database layer and run the
   cron sweep. Imported only when STUDIO_DB=d1 (see src/db/index.ts). */

type Env = { DB?: unknown; CRON_SECRET?: string; STUDIO_PUBLIC_URL?: string };

export async function bindD1(): Promise<unknown | null> {
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const { env } = getCloudflareContext() as { env: Env };
  return env.DB ?? null;
}
