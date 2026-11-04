import type { LookSettings, ShotInput, TimelineInput } from "./schemas";

export type Approval = "draft" | "approved";

export type Project = {
  id: string;
  name: string;
  look: LookSettings;
  budgetCapUsd: number;
  spentUsd: number;
  shotlistApproval: Approval;
  shotlistApprovedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type Script = {
  id: string;
  projectId: string;
  version: number;
  text: string;
  approval: Approval;
  approvedAt?: number;
  createdAt: number;
};

export type AssetKind = "image" | "video" | "audio";
export type AssetSource = "upload" | "generated" | "frame-extract" | "export";

export type Asset = {
  id: string;
  projectId: string | null;
  url: string;
  kind: AssetKind;
  source: AssetSource;
  width?: number;
  height?: number;
  durationS?: number;
  meta: Record<string, unknown>;
  createdAt: number;
};

export type ElementKind = "character" | "location" | "prop";

export type Element = {
  id: string;
  /** null = global library */
  projectId: string | null;
  kind: ElementKind;
  name: string;
  description: string;
  refAssetIds: string[];
  voiceAssetId?: string;
  createdAt: number;
  updatedAt: number;
};

export type Scene = {
  id: string;
  projectId: string;
  index: number;
  slug: string;
  summary: string;
  locationElementId?: string;
  createdAt: number;
};

export type Shot = {
  id: string;
  projectId: string;
  sceneId: string;
  index: number;
  spec: ShotInput;
  heroAssetId?: string;
  endAssetId?: string;
  selectedTakeId?: string;
  promptOverride?: string;
  createdAt: number;
  updatedAt: number;
};

export type TakeStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "timeout";

export type Review = { score: number; notes: string; by: "human" | "agent"; at: number };

export type Take = {
  id: string;
  projectId: string;
  shotId: string;
  n: number;
  backend: "runpod" | "higgsfield";
  workflow: string;
  prompt: string;
  input: Record<string, unknown>;
  requestId?: string;
  status: TakeStatus;
  resultUrl?: string;
  lastFrameUrl?: string;
  thumbUrls: string[];
  executionMs?: number;
  costUsd?: number;
  seed?: number;
  gpuTypeId?: string;
  gpuCostPerHr?: number;
  outputSeconds?: number;
  error?: string;
  review?: Review;
  createdAt: number;
  finishedAt?: number;
};

export type Timeline = TimelineInput;

export type LoraKind = "speed" | "style" | "effect";

export type Lora = {
  id: string;
  name: string;
  kind: LoraKind;
  filename: string;
  hfUrl?: string;
  triggerWords: string;
  defaultStrength: number;
  stepsHint?: number;
  workflows: string[];
  notes: string;
  createdAt: number;
  updatedAt: number;
};

export type GpuTypeStats = {
  gpuTypeId: string;
  takes: number;
  genSeconds: number;
  videoSeconds: number;
  /** GPU seconds per second of output; the number the cost model needs. */
  secondsPerOutputSecond: number;
  usdPerHr?: number;
  usdPerVideoSecond?: number;
};

export type ExportStatus = "queued" | "running" | "completed" | "failed";

export type ExportJob = {
  id: string;
  projectId: string;
  preset: string;
  status: ExportStatus;
  requestId?: string;
  input: Record<string, unknown>;
  resultUrl?: string;
  srtUrl?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
};

export type JobKind = "hero-frames" | "element-refs";
export type JobStatus = "queued" | "running" | "completed" | "failed";

export type Job = {
  id: string;
  projectId: string;
  kind: JobKind;
  targetId: string;
  backend: string;
  requestId?: string;
  status: JobStatus;
  assetIds: string[];
  costUsd?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
};

export type Actor = { user: string; via: "web" | "mcp" | "hook" };
