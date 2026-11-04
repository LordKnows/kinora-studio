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
  /** "dev" trusts every request as DEV_USER and must be asked for explicitly;
      anything else verifies Cloudflare Access JWTs, so a missing variable
      fails closed. */
  authMode: (): "dev" | "access" => (env("AUTH_MODE") === "dev" ? "dev" : "access"),
  devUser: (): string => env("DEV_USER") ?? "dev@local",
  access: () => ({ teamDomain: need("CF_ACCESS_TEAM_DOMAIN"), aud: need("CF_ACCESS_AUD") }),

  publicUrl: (): string => (env("STUDIO_PUBLIC_URL") ?? "http://localhost:3000").replace(/\/$/, ""),

  /** "pod": a Secure Cloud pod the studio starts and stops (default).
      "serverless": RunPod endpoints — kept in the code but a TODO for now. */
  runpodMode: (): "pod" | "serverless" => (env("RUNPOD_MODE") === "serverless" ? "serverless" : "pod"),

  runpod: () => ({
    apiKey: need("RUNPOD_API_KEY"),
    webhookSecret: need("RUNPOD_WEBHOOK_SECRET"),
    /** USD per GPU-second of the H3 endpoint, used for estimates and ledgers. */
    gpuUsdPerSecond: Number(env("RUNPOD_GPU_USD_PER_SECOND") ?? "0.0012"),
    /** Measured seconds of GPU time per second of output, until P0 fills it in. */
    secondsPerOutputSecond: Number(env("RUNPOD_SECONDS_PER_OUTPUT_SECOND") ?? "12"),
    coldStartSeconds: Number(env("RUNPOD_COLD_START_SECONDS") ?? "90"),
    executionTimeoutMs: Number(env("RUNPOD_EXECUTION_TIMEOUT_MS") ?? "900000"),
  }),

  /** Serverless endpoints (TODO: not the default any more). */
  runpodServerless: () => ({
    h3EndpointId: need("RUNPOD_ENDPOINT_ID"),
    assemblerEndpointId: env("RUNPOD_ASSEMBLER_ENDPOINT_ID"),
  }),

  /** The pod the studio manages: what image, which GPUs it may land on, where
      the models live. The pod runs workers/h3-runpod/server.py on podPort. */
  runpodPod: () => ({
    image: need("RUNPOD_POD_IMAGE"),
    gpuTypeIds: (env("RUNPOD_GPU_TYPES") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    networkVolumeId: env("RUNPOD_NETWORK_VOLUME_ID"),
    dataCenterIds: (env("RUNPOD_DATACENTER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    cloudType: (env("RUNPOD_CLOUD_TYPE") ?? "SECURE").toUpperCase(),
    containerDiskGb: Number(env("RUNPOD_CONTAINER_DISK_GB") ?? "50"),
    volumeMountPath: env("RUNPOD_VOLUME_MOUNT_PATH") ?? "/runpod-volume",
    podPort: Number(env("RUNPOD_POD_PORT") ?? "8000"),
    comfyPort: Number(env("RUNPOD_COMFY_PORT") ?? "8188"),
    idleStopMinutes: Number(env("RUNPOD_IDLE_STOP_MINUTES") ?? "15"),
    workerToken: need("STUDIO_WORKER_TOKEN"),
    podName: env("RUNPOD_POD_NAME") ?? "cinema-studio-h3",
  }),

  r2: () => ({
    accountId: need("R2_ACCOUNT_ID"),
    bucket: need("R2_BUCKET"),
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
    publicBaseUrl: need("R2_PUBLIC_BASE_URL").replace(/\/$/, ""),
  }),
  r2Configured: (): boolean => Boolean(env("R2_ACCOUNT_ID") && env("R2_BUCKET")),

  /** Static bearer for clients that cannot do OAuth (Claude Code, curl). */
  mcpStaticToken: (): string | undefined => env("MCP_STATIC_TOKEN"),
};
