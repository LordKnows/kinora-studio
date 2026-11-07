import { StudioError } from "../errors";

/* RunPod's REST API for pods. Two generations exist: v1 (rest.runpod.io/v1,
   gpuTypeIds[] + networkVolumeId) and v2 (api.runpod.io/v2, one gpu per
   request, volumes through mounts.network, PATCH to edit a pod). v1 cannot
   see or attach a global network volume, so v2 is the default; RUNPOD_API=v1
   switches back. Field names live here only. Not verifiable offline — the
   deploy guide says how to check. */

export type ApiVersion = "v1" | "v2";

export type PodRecord = {
  id: string;
  name: string;
  desiredStatus: string;
  costPerHr?: number;
  gpuTypeId?: string;
  gpuDisplayName?: string;
  dataCenterId?: string;
  portMappings: Record<string, number>;
  /** Ports RunPod reports as exposed ("8000/http"), when it reports any. */
  exposedPorts: string[];
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
  /** Replaces the image's ENTRYPOINT (exec form). Needed for images such as
      runpod/comfyui whose ENTRYPOINT ignores any start command passed as
      arguments. v1: dockerEntrypoint; v2: entrypoint. */
  dockerEntrypoint?: string[];
  /** Replaces the image's CMD (v1: dockerStartCmd). Only useful when the image has no ENTRYPOINT. */
  dockerStartCmd?: string[];
  /** The same command as one shell-split string (v2 "args", console field). */
  dockerStartLine?: string;
};

export type PodPatch = { args?: string; entrypoint?: string[]; env?: Record<string, string>; image?: string };

const NO_RESOURCE_PATTERNS = [/no longer any instances/i, /no instances available/i, /not enough.*resources/i, /unavailable/i, /no gpu/i, /out of stock/i, /capacity/i];

export function isNoResources(message: string): boolean {
  return NO_RESOURCE_PATTERNS.some((re) => re.test(message));
}

export class RunPodPodsClient {
  private readonly base: string;
  private readonly baseV2: string;
  readonly version: ApiVersion;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly apiKey: string, opts?: { baseUrl?: string; baseUrlV2?: string; version?: ApiVersion; fetch?: typeof fetch }) {
    this.base = (opts?.baseUrl ?? "https://rest.runpod.io/v1").replace(/\/$/, "");
    this.baseV2 = (opts?.baseUrlV2 ?? "https://api.runpod.io/v2").replace(/\/$/, "");
    this.version = opts?.version ?? "v2";
    this.fetchImpl = opts?.fetch ?? fetch;
  }

  private v2(): boolean {
    return this.version === "v2";
  }

  private async call(method: string, path: string, body?: unknown, base: string = this.base): Promise<unknown> {
    const res = await this.fetchImpl(`${base}${path}`, {
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
      const message = `RunPod ${method} ${base === this.baseV2 ? "v2 " : ""}${path} failed (${res.status})${detail ? `: ${detail}` : ""}${problems.length ? ` — ${problems.map(String).join(" | ")}` : raw && !detail ? `: ${raw.slice(0, 1500)}` : ""}`;
      throw new StudioError("backend_error", message, { status: res.status, body: payload, noResources: isNoResources(message) });
    }
    return payload;
  }

  private callV2(method: string, path: string, body?: unknown): Promise<unknown> {
    return this.call(method, path, body, this.baseV2);
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
    if (this.v2()) return this.createPodV2(input, overrides);
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
      ...(input.dockerEntrypoint?.length ? { dockerEntrypoint: input.dockerEntrypoint } : {}),
      ...(input.dockerStartCmd?.length && !input.dockerEntrypoint?.length ? { dockerStartCmd: input.dockerStartCmd } : {}),
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

  /* v2: one GPU type per request (the caller walks the allow-list), the
     volume as a network mount, the start command as one string. */
  private async createPodV2(input: CreatePodInput, overrides?: Record<string, unknown>): Promise<PodRecord> {
    const gpuId = input.gpuTypeIds[0];
    if (!gpuId) throw new StudioError("backend_error", "no GPU type to request");
    const base: Record<string, unknown> = {
      name: input.name,
      image: input.imageName,
      cloud: input.cloudType,
      gpu: { id: gpuId, count: 1, ...(input.allowedCudaVersions?.length ? { allowedCudaVersions: input.allowedCudaVersions } : {}) },
      disk: input.containerDiskInGb,
      ports: input.ports,
      env: input.env,
      ...(input.dockerEntrypoint?.length ? { entrypoint: input.dockerEntrypoint } : input.dockerStartLine ? { args: input.dockerStartLine } : {}),
      ...(input.dataCenterIds?.length ? { dataCenterIds: input.dataCenterIds } : {}),
    };
    /* How the model volume is attached. RunPod documents mounts.network for
       network volumes; global volumes (beta) have no documented pod field,
       so when the network form is refused as "not found" the other shapes
       are tried, cheapest first. Every attempt and answer is reported. */
    const encodings: Array<[string, Record<string, unknown>]> = input.networkVolumeId
      ? [
          ["mounts.network", { mounts: { network: [{ volumeId: input.networkVolumeId, path: input.volumeMountPath }] } }],
          ["mounts.global[]", { mounts: { global: [{ volumeId: input.networkVolumeId, path: input.volumeMountPath }] } }],
          ["mounts.global{}", { mounts: { global: { volumeId: input.networkVolumeId, path: input.volumeMountPath } } }],
          ["globalVolumeId", { globalVolumeId: input.networkVolumeId, volumeMountPath: input.volumeMountPath }],
        ]
      : [["no volume", {}]];
    const attempts: string[] = [];
    for (const [label, mount] of encodings) {
      const body: Record<string, unknown> = { ...base, ...mount };
      for (const [k, v] of Object.entries(overrides ?? {})) {
        if (v === null) delete body[k];
        else body[k] = v;
      }
      try {
        return mapPod(await this.callV2("POST", "/pods", body));
      } catch (caught) {
        if (!(caught instanceof StudioError) || caught.code !== "backend_error") throw caught;
        const details = caught.details as { status?: number; noResources?: boolean } | undefined;
        attempts.push(`${label}: ${caught.message}`);
        const volumeTrouble = /volume.*not found|not found.*volume|mounts|unknown (field|propert)|unrecognized|additional propert/i.test(caught.message) && !details?.noResources;
        if (volumeTrouble && encodings.indexOf(encodings.find((e) => e[0] === label)!) < encodings.length - 1) continue;
        const sent = { gpu: body.gpu, dataCenterIds: body.dataCenterIds, volume: mount, cloud: body.cloud, keys: Object.keys(body) };
        throw new StudioError("backend_error", `${attempts.length > 1 ? `tried ${attempts.length} volume encodings — ${attempts.join(" || ")}` : caught.message} — sent ${JSON.stringify(sent)}`, { ...(details as object), sent, attempts });
      }
    }
    throw new StudioError("backend_error", `pod creation failed: ${attempts.join(" || ")}`, { attempts });
  }

  /**
   * A CPU pod (the painter): one flavor per request — the caller walks its
   * list on "no resources" — a network volume, and the start command as an
   * exec-form entrypoint (no shell splitting). v2: `cpu {id, vcpuCount}` and
   * `mounts.network`; v1: computeType CPU, cpuFlavorIds, networkVolumeId.
   */
  async createCpuPod(input: { name: string; image: string; flavorId: string; vcpuCount: number; diskGb: number; env: Record<string, string>; entrypoint: string[]; dataCenterId?: string; networkVolumeId?: string; mountPath: string }): Promise<PodRecord> {
    const body: Record<string, unknown> = this.v2()
      ? {
          name: input.name, image: input.image, cloud: "SECURE", cpu: { id: input.flavorId, vcpuCount: input.vcpuCount }, disk: input.diskGb, env: input.env,
          entrypoint: input.entrypoint, ports: [],
          ...(input.networkVolumeId ? { mounts: { network: [{ volumeId: input.networkVolumeId, path: input.mountPath }] } } : {}),
          ...(input.dataCenterId ? { dataCenterIds: [input.dataCenterId] } : {}),
        }
      : {
          name: input.name, imageName: input.image, computeType: "CPU", cpuFlavorIds: [input.flavorId], vcpuCount: input.vcpuCount, containerDiskInGb: input.diskGb, env: input.env,
          dockerEntrypoint: input.entrypoint, cloudType: "SECURE", volumeInGb: 0,
          ...(input.networkVolumeId ? { networkVolumeId: input.networkVolumeId, volumeMountPath: input.mountPath } : {}),
          ...(input.dataCenterId ? { dataCenterIds: [input.dataCenterId] } : {}),
        };
    try {
      return mapPod(this.v2() ? await this.callV2("POST", "/pods", body) : await this.call("POST", "/pods", body));
    } catch (caught) {
      if (caught instanceof StudioError && caught.code === "backend_error") {
        const sent = { flavor: input.flavorId, vcpuCount: input.vcpuCount, dataCenterId: input.dataCenterId, networkVolumeId: input.networkVolumeId, keys: Object.keys(body) };
        throw new StudioError("backend_error", `${caught.message} — sent ${JSON.stringify(sent)}`, { ...(caught.details as object), sent });
      }
      throw caught;
    }
  }

  async getPod(id: string): Promise<PodRecord | null> {
    try {
      return mapPod(this.v2() ? await this.callV2("GET", `/pods/${encodeURIComponent(id)}`) : await this.call("GET", `/pods/${encodeURIComponent(id)}`));
    } catch (caught) {
      if (caught instanceof StudioError && (caught.details as { status?: number } | undefined)?.status === 404) return null;
      throw caught;
    }
  }

  async startPod(id: string): Promise<PodRecord> {
    if (this.v2()) {
      await this.callV2("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "start" });
      return (await this.getPod(id)) ?? { id, name: "", desiredStatus: "STARTING", portMappings: {}, exposedPorts: [] };
    }
    return mapPod(await this.call("POST", `/pods/${encodeURIComponent(id)}/start`));
  }

  async stopPod(id: string): Promise<void> {
    if (this.v2()) await this.callV2("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "stop" });
    else await this.call("POST", `/pods/${encodeURIComponent(id)}/stop`);
  }

  async restartPod(id: string): Promise<void> {
    if (this.v2()) await this.callV2("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "restart" });
    else {
      await this.call("POST", `/pods/${encodeURIComponent(id)}/stop`);
      await this.call("POST", `/pods/${encodeURIComponent(id)}/start`);
    }
  }

  async terminatePod(id: string): Promise<void> {
    if (this.v2()) await this.callV2("DELETE", `/pods/${encodeURIComponent(id)}`);
    else await this.call("DELETE", `/pods/${encodeURIComponent(id)}`);
  }

  /** Edit a pod in place: start command, env, image. v2 PATCH is partial
      (omitted fields stay); v1 has no equivalent we trust, so it refuses. */
  async updatePod(id: string, patch: PodPatch): Promise<PodRecord> {
    if (!this.v2()) throw new StudioError("backend_error", "editing a pod needs RUNPOD_API=v2");
    const body: Record<string, unknown> = {};
    if (patch.args !== undefined) body.args = patch.args;
    if (patch.entrypoint !== undefined) body.entrypoint = patch.entrypoint;
    if (patch.env !== undefined) body.env = patch.env;
    if (patch.image !== undefined) body.image = patch.image;
    const answer = await this.callV2("PATCH", `/pods/${encodeURIComponent(id)}`, body);
    try {
      return mapPod(answer);
    } catch {
      return (await this.getPod(id)) ?? { id, name: "", desiredStatus: "UNKNOWN", portMappings: {}, exposedPorts: [] };
    }
  }

  /** What v2 reports for a pod, raw: env and args when it returns them. */
  async getPodRaw(id: string): Promise<Record<string, unknown> | null> {
    try {
      const payload = this.v2() ? await this.callV2("GET", `/pods/${encodeURIComponent(id)}`) : await this.call("GET", `/pods/${encodeURIComponent(id)}`);
      return asRecord(payload);
    } catch (caught) {
      if (caught instanceof StudioError && (caught.details as { status?: number } | undefined)?.status === 404) return null;
      throw caught;
    }
  }

  /** REST first, GraphQL second, the built-in catalog last — a GPU listing
      must never stop a pod from being requested. `source` says which answered. */
  /** Network volumes visible to this API key: REST and GraphQL are both
      asked and merged, and the raw answers are returned for diagnosis. */
  async listNetworkVolumes(): Promise<{ volumes: Array<{ id: string; name: string; size?: number; dataCenterId?: string }>; raw: { rest?: unknown; v2?: unknown; v2global?: unknown; graphql?: unknown; errors: string[] } }> {
    const shape = (raw: unknown) => {
      const r = asRecord(raw);
      return { id: str(r.id) ?? "", name: str(r.name) ?? "", size: num(r.size), dataCenterId: str(r.dataCenterId) ?? str(r.dataCenter) };
    };
    const found = new Map<string, ReturnType<typeof shape>>();
    const raw: { rest?: unknown; v2?: unknown; v2global?: unknown; graphql?: unknown; errors: string[] } = { errors: [] };
    try {
      const payload = await this.callV2("GET", "/network-volumes");
      raw.v2 = payload;
      const inner = (payload as Record<string, unknown> | null)?.networkVolumes;
      for (const v of (Array.isArray(inner) ? inner : Array.isArray(payload) ? payload : []).map(shape)) if (v.id) found.set(v.id, v);
    } catch (caught) {
      raw.errors.push(`v2: ${caught instanceof Error ? caught.message : caught}`);
    }
    try {
      const payload = await this.callV2("GET", "/global-volumes");
      raw.v2global = payload;
      const r = asRecord(payload);
      const inner = r.globalVolumes ?? r.volumes ?? r.data ?? r.items;
      for (const v of (Array.isArray(inner) ? inner : Array.isArray(payload) ? payload : []).map(shape)) if (v.id) found.set(v.id, { ...v, dataCenterId: v.dataCenterId ?? "global" });
    } catch (caught) {
      raw.errors.push(`v2 global: ${caught instanceof Error ? caught.message : caught}`);
    }
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
  const exposed: string[] = [];
  const runtimePorts = asRecord(r.runtime).ports;
  if (Array.isArray(runtimePorts)) {
    for (const p of runtimePorts) {
      const pr = asRecord(p);
      const priv = num(pr.privatePort) ?? num(pr.private) ?? num(pr.port);
      if (priv !== undefined) exposed.push(`${priv}/${str(pr.type) ?? "?"}`);
    }
  }
  if (Array.isArray(r.ports)) for (const p of r.ports) if (typeof p === "string") exposed.push(p);
  for (const k of Object.keys(mappings)) if (!exposed.some((e) => e.startsWith(`${k}/`))) exposed.push(`${k}/?`);
  return {
    id,
    name: str(r.name) ?? "",
    exposedPorts: [...new Set(exposed)],
    desiredStatus: str(r.desiredStatus) ?? str(r.status) ?? "UNKNOWN",
    costPerHr: num(r.costPerHr) ?? num(r.cost) ?? num(asRecord(r.cost).perHour) ?? num(asRecord(r.cost).hourly),
    gpuTypeId: str(machine.gpuTypeId) ?? str(gpu.id) ?? str(r.gpuTypeId),
    gpuDisplayName: str(machine.gpuDisplayName) ?? str(gpu.displayName) ?? str(r.gpuDisplayName) ?? (str(gpu.id) ? str(gpu.id)!.replace(/^NVIDIA (GeForce )?/, "") : undefined),
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
