import { StudioError } from "../errors";

/* RunPod's REST API for pods (https://rest.runpod.io/v1). Kept to the handful
   of calls the studio needs, with the field names in one place: if RunPod
   renames one, this is the only file to touch. Not verifiable offline — the
   deploy guide says how to check. */

export type PodRecord = {
  id: string;
  name: string;
  desiredStatus: string;
  costPerHr?: number;
  gpuTypeId?: string;
  gpuDisplayName?: string;
  dataCenterId?: string;
  portMappings: Record<string, number>;
  publicIp?: string;
  lastStartedAt?: string;
};

export type GpuType = { id: string; displayName: string; memoryInGb?: number; secureCloud?: boolean; communityCloud?: boolean; securePrice?: number; communityPrice?: number; source?: "catalog" };

export type CreatePodInput = {
  name: string;
  imageName: string;
  gpuTypeIds: string[];
  cloudType: string;
  containerDiskInGb: number;
  volumeMountPath: string;
  networkVolumeId?: string;
  dataCenterIds?: string[];
  ports: string[];
  env: Record<string, string>;
  allowedCudaVersions?: string[];
  /** Replaces the image's start command (RunPod: dockerStartCmd). */
  dockerStartCmd?: string[];
};

const NO_RESOURCE_PATTERNS = [/no longer any instances/i, /no instances available/i, /not enough.*resources/i, /unavailable/i, /no gpu/i, /out of stock/i, /capacity/i];

export function isNoResources(message: string): boolean {
  return NO_RESOURCE_PATTERNS.some((re) => re.test(message));
}

export class RunPodPodsClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, opts?: { baseUrl?: string; fetch?: typeof fetch }) {
    this.base = (opts?.baseUrl ?? "https://rest.runpod.io/v1").replace(/\/$/, "");
    this.fetchImpl = opts?.fetch ?? fetch;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!res.ok) {
      const detail = Array.isArray(payload) ? errorMessage(payload[0]) : errorMessage(payload);
      const raw = typeof payload === "string" ? payload : payload ? JSON.stringify(payload) : "";
      /* Schema errors list every offending property under "problems": keep them. */
      const problems = Array.isArray(payload) ? payload.flatMap((p) => (asRecord(p).problems as unknown[] | undefined) ?? []) : (asRecord(payload).problems as unknown[] | undefined) ?? [];
      const message = `RunPod ${method} ${path} failed (${res.status})${detail ? `: ${detail}` : ""}${problems.length ? ` — ${problems.map(String).join(" | ")}` : raw && !detail ? `: ${raw.slice(0, 1500)}` : ""}`;
      throw new StudioError("backend_error", message, { status: res.status, body: payload, noResources: isNoResources(message) });
    }
    return payload;
  }

  /** The GraphQL API (api.runpod.io/graphql) as a fallback for listings the
      REST API does not expose the way we expected. */
  private async graphql<T>(query: string): Promise<T> {
    const res = await this.fetchImpl(`https://api.runpod.io/graphql?api_key=${encodeURIComponent(this.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ query }),
    });
    const payload = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ message: string }> } | null;
    if (!res.ok || !payload?.data) {
      throw new StudioError("backend_error", `RunPod GraphQL failed (${res.status}): ${payload?.errors?.map((e) => e.message).join("; ") ?? "no data"}`, { status: res.status, body: payload });
    }
    return payload.data;
  }

  async createPod(input: CreatePodInput, overrides?: Record<string, unknown>): Promise<PodRecord> {
    const body: Record<string, unknown> = {
      name: input.name,
      imageName: input.imageName,
      gpuTypeIds: input.gpuTypeIds,
      gpuTypePriority: "availability",
      gpuCount: 1,
      cloudType: input.cloudType,
      computeType: "GPU",
      containerDiskInGb: input.containerDiskInGb,
      volumeInGb: 0,
      volumeMountPath: input.volumeMountPath,
      ports: input.ports,
      env: input.env,
      supportPublicIp: true,
      interruptible: false,
      ...(input.networkVolumeId ? { networkVolumeId: input.networkVolumeId } : {}),
      ...(input.allowedCudaVersions?.length ? { allowedCudaVersions: input.allowedCudaVersions } : {}),
      ...(input.dockerStartCmd?.length ? { dockerStartCmd: input.dockerStartCmd } : {}),
      ...(input.dataCenterIds?.length ? { dataCenterIds: input.dataCenterIds } : {}),
    };
    /* RUNPOD_POD_BODY_OVERRIDES: a JSON object merged last; null deletes a key.
       The escape hatch for a field RunPod's schema names differently. */
    for (const [k, v] of Object.entries(overrides ?? {})) {
      if (v === null) delete body[k];
      else body[k] = v;
    }
    try {
      return mapPod(await this.call("POST", "/pods", body));
    } catch (caught) {
      /* Echo what was sent: a schema error names the field, not the value. */
      if (caught instanceof StudioError && caught.code === "backend_error") {
        const sent = { gpuTypeIds: body.gpuTypeIds, dataCenterIds: body.dataCenterIds, networkVolumeId: body.networkVolumeId, cloudType: body.cloudType, keys: Object.keys(body) };
        throw new StudioError("backend_error", `${caught.message} — sent ${JSON.stringify(sent)}`, { ...(caught.details as object), sent });
      }
      throw caught;
    }
  }

  async getPod(id: string): Promise<PodRecord | null> {
    try {
      return mapPod(await this.call("GET", `/pods/${encodeURIComponent(id)}`));
    } catch (caught) {
      if (caught instanceof StudioError && (caught.details as { status?: number } | undefined)?.status === 404) return null;
      throw caught;
    }
  }

  async startPod(id: string): Promise<PodRecord> {
    return mapPod(await this.call("POST", `/pods/${encodeURIComponent(id)}/start`));
  }

  async stopPod(id: string): Promise<void> {
    await this.call("POST", `/pods/${encodeURIComponent(id)}/stop`);
  }

  async terminatePod(id: string): Promise<void> {
    await this.call("DELETE", `/pods/${encodeURIComponent(id)}`);
  }

  /** REST first, GraphQL second, the built-in catalog last — a GPU listing
      must never stop a pod from being requested. `source` says which answered. */
  /** Network volumes visible to this API key: REST and GraphQL are both
      asked and merged, and the raw answers are returned for diagnosis. */
  async listNetworkVolumes(): Promise<{ volumes: Array<{ id: string; name: string; size?: number; dataCenterId?: string }>; raw: { rest?: unknown; graphql?: unknown; errors: string[] } }> {
    const shape = (raw: unknown) => {
      const r = asRecord(raw);
      return { id: str(r.id) ?? "", name: str(r.name) ?? "", size: num(r.size), dataCenterId: str(r.dataCenterId) };
    };
    const found = new Map<string, ReturnType<typeof shape>>();
    const raw: { rest?: unknown; graphql?: unknown; errors: string[] } = { errors: [] };
    try {
      const payload = await this.call("GET", "/networkvolumes");
      raw.rest = payload;
      const list = Array.isArray(payload) ? payload : [];
      for (const key of ["networkVolumes", "volumes", "data", "items"]) {
        const inner = (payload as Record<string, unknown> | null)?.[key];
        if (Array.isArray(inner)) list.push(...inner);
      }
      for (const v of list.map(shape)) if (v.id) found.set(v.id, v);
    } catch (caught) {
      raw.errors.push(`REST: ${caught instanceof Error ? caught.message : caught}`);
    }
    try {
      const data = await this.graphql<{ myself: { networkVolumes: unknown[] } }>("{ myself { networkVolumes { id name size dataCenterId } } }");
      raw.graphql = data;
      for (const v of (data.myself?.networkVolumes ?? []).map(shape)) if (v.id) found.set(v.id, v);
    } catch (caught) {
      raw.errors.push(`GraphQL: ${caught instanceof Error ? caught.message : caught}`);
    }
    return { volumes: [...found.values()], raw };
  }

  async listGpuTypes(): Promise<GpuType[]> {
    const errors: string[] = [];
    try {
      const payload = await this.call("GET", "/gputypes");
      const list = Array.isArray(payload) ? payload : Array.isArray((payload as { gpuTypes?: unknown })?.gpuTypes) ? (payload as { gpuTypes: unknown[] }).gpuTypes : [];
      if (list.length) return list.map(mapGpuType);
      errors.push("REST /gputypes answered with no types");
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
    try {
      const data = await this.graphql<{ gpuTypes: unknown[] }>("{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice } }");
      if (data.gpuTypes?.length) return data.gpuTypes.map(mapGpuType);
      errors.push("GraphQL gpuTypes answered with no types");
    } catch (caught) {
      errors.push(caught instanceof Error ? caught.message : String(caught));
    }
    console.warn("[runpod] gpu type listing unavailable, using the built-in catalog:", errors.join(" | "));
    return KNOWN_GPU_TYPES.map((id) => ({ id, displayName: id.replace(/^NVIDIA /, ""), source: "catalog" }));
  }


}

function mapGpuType(raw: unknown): GpuType {
  const r = asRecord(raw);
  return {
    id: str(r.id) ?? "",
    displayName: str(r.displayName) ?? str(r.id) ?? "",
    memoryInGb: num(r.memoryInGb),
    secureCloud: typeof r.secureCloud === "boolean" ? r.secureCloud : undefined,
    communityCloud: typeof r.communityCloud === "boolean" ? r.communityCloud : undefined,
    securePrice: num(r.securePrice),
    communityPrice: num(r.communityPrice),
  };
}

/* The gpuTypeIds RunPod's POST /pods accepts (its own schema enum, copied from
   the 400 it returns otherwise). The allow-list resolves against this; the
   live listing only decorates it with prices. */
export const KNOWN_GPU_TYPES = [
  "AMD Instinct MI300X OAM",
  "NVIDIA A100 80GB PCIe",
  "NVIDIA A100-SXM4-40GB",
  "NVIDIA A100-SXM4-80GB",
  "NVIDIA A40",
  "NVIDIA B200",
  "NVIDIA B300 SXM6 AC",
  "NVIDIA B300 SXM6 AC MIG 1g.34gb",
  "NVIDIA GeForce RTX 3070",
  "NVIDIA GeForce RTX 3080",
  "NVIDIA GeForce RTX 3080 Ti",
  "NVIDIA GeForce RTX 3090",
  "NVIDIA GeForce RTX 3090 Ti",
  "NVIDIA GeForce RTX 4070 Ti",
  "NVIDIA GeForce RTX 4080",
  "NVIDIA GeForce RTX 4080 SUPER",
  "NVIDIA GeForce RTX 4090",
  "NVIDIA GeForce RTX 5080",
  "NVIDIA GeForce RTX 5090",
  "NVIDIA H100 80GB HBM3",
  "NVIDIA H100 NVL",
  "NVIDIA H100 PCIe",
  "NVIDIA H200",
  "NVIDIA H200 NVL",
  "NVIDIA L4",
  "NVIDIA L40",
  "NVIDIA L40S",
  "NVIDIA RTX 2000 Ada Generation",
  "NVIDIA RTX 4000 Ada Generation",
  "NVIDIA RTX 4000 SFF Ada Generation",
  "NVIDIA RTX 5000 Ada Generation",
  "NVIDIA RTX 6000 Ada Generation",
  "NVIDIA RTX A2000",
  "NVIDIA RTX A4000",
  "NVIDIA RTX A4500",
  "NVIDIA RTX A5000",
  "NVIDIA RTX A6000",
  "NVIDIA RTX PRO 4000 Blackwell",
  "NVIDIA RTX PRO 4500 Blackwell",
  "NVIDIA RTX PRO 5000 Blackwell",
  "NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition",
  "NVIDIA RTX PRO 6000 Blackwell Server Edition",
  "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
  "Tesla V100-PCIE-16GB",
  "Tesla V100-SXM2-16GB",
];
export const KNOWN_GPU_TYPE_SET = new Set(KNOWN_GPU_TYPES);

export function mapPod(payload: unknown): PodRecord {
  const r = asRecord(payload);
  const machine = asRecord(r.machine);
  const gpu = asRecord(r.gpu);
  const id = str(r.id);
  if (!id) throw new StudioError("backend_error", "RunPod answered without a pod id", payload);
  const mappings: Record<string, number> = {};
  const pm = r.portMappings;
  if (pm && typeof pm === "object" && !Array.isArray(pm)) {
    for (const [k, v] of Object.entries(pm as Record<string, unknown>)) if (typeof v === "number") mappings[k] = v;
  }
  return {
    id,
    name: str(r.name) ?? "",
    desiredStatus: str(r.desiredStatus) ?? str(r.status) ?? "UNKNOWN",
    costPerHr: num(r.costPerHr),
    gpuTypeId: str(machine.gpuTypeId) ?? str(gpu.id) ?? str(r.gpuTypeId),
    gpuDisplayName: str(machine.gpuDisplayName) ?? str(gpu.displayName) ?? str(r.gpuDisplayName),
    dataCenterId: str(machine.dataCenterId) ?? str(r.dataCenterId),
    portMappings: mappings,
    publicIp: str(r.publicIp),
    lastStartedAt: str(r.lastStartedAt),
  };
}

/** The HTTP proxy RunPod puts in front of an exposed http port. */
export function podProxyUrl(podId: string, port: number): string {
  return `https://${podId}-${port}.proxy.runpod.net`;
}

function errorMessage(payload: unknown): string | undefined {
  const r = asRecord(payload);
  for (const key of ["error", "message", "detail"]) {
    const v = r[key];
    if (typeof v === "string" && v) return v;
    if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") return (v as { message: string }).message;
  }
  return undefined;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
