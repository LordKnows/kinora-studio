/* Server-only configuration. Every secret lives in the environment (Workers
   secrets in production, .env.local in development) and never in a cookie. */

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function need(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export const config = {
  /** "dev" trusts every request as DEV_USER; "access" verifies Cloudflare Access JWTs. */
  authMode: (): "dev" | "access" => (env("AUTH_MODE") === "access" ? "access" : "dev"),
  devUser: (): string => env("DEV_USER") ?? "dev@local",
  access: () => ({ teamDomain: need("CF_ACCESS_TEAM_DOMAIN"), aud: need("CF_ACCESS_AUD") }),

  publicUrl: (): string => (env("STUDIO_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, ""),

  runpod: () => ({
    apiKey: need("RUNPOD_API_KEY"),
    h3EndpointId: need("RUNPOD_ENDPOINT_ID"),
    assemblerEndpointId: env("RUNPOD_ASSEMBLER_ENDPOINT_ID"),
    webhookSecret: need("RUNPOD_WEBHOOK_SECRET"),
    /** USD per GPU-second of the H3 endpoint, used for estimates and ledgers. */
    gpuUsdPerSecond: Number(env("RUNPOD_GPU_USD_PER_SECOND") ?? "0.0012"),
    /** Measured seconds of GPU time per second of output, until P0 fills it in. */
    secondsPerOutputSecond: Number(env("RUNPOD_SECONDS_PER_OUTPUT_SECOND") ?? "12"),
    coldStartSeconds: Number(env("RUNPOD_COLD_START_SECONDS") ?? "90"),
    executionTimeoutMs: Number(env("RUNPOD_EXECUTION_TIMEOUT_MS") ?? "900000"),
  }),

  r2: () => ({
    accountId: need("R2_ACCOUNT_ID"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    publicBaseUrl: need("R2_PUBLIC_BASE_URL").replace(/\/$/, ""),
  }),
  r2Configured: (): boolean => Boolean(env("R2_ACCOUNT_ID") && env("R2_BUCKET")),

  higgsfield: () => ({ baseUrl: env("HF_API_BASE_URL"), apiKey: env("HF_API_KEY") }),

  /** Static bearer for clients that cannot do OAuth (Claude Code, curl). */
  mcpStaticToken: (): string | undefined => env("MCP_STATIC_TOKEN"),

  /** USD per image from the Higgsfield image models, for the ledger. */
  imageUsd: (): number => Number(env("IMAGE_USD_PER_RESULT") ?? "0.05"),
};
