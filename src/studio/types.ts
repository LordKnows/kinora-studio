import type { InferenceParams } from "./models";
import type { FixedFeature, LookSettings, RefView, ScenePalette, ShotInput, TakeFault, TimelineInput } from "./schemas";

export type Approval = "draft" | "approved";

export type Project = {
  id: string;
  name: string;
  look: LookSettings;
  budgetCapUsd: number;
  spentUsd: number;
  brief: string;
  targetSeconds?: number;
  shotlistApproval: Approval;
  shotlistApprovedAt?: number;
  /** Spend envelope the user granted on the web; inside it the agent may render without asking each time. */
  autopilot?: Autopilot;
  /** Checkpoints the user lets the director pass (granted on the web only). */
  delegation?: Delegation;
  /** GPT Image on this project: off unless switched on in Settings (web only). */
  imaging?: Imaging;
  createdAt: number;
  updatedAt: number;
};

export type Autopilot = {
  envelopeUsd: number;
  /** Spent against the envelope since it was granted. */
  usedUsd: number;
  grantedAt: number;
  grantedBy: string;
  expiresAt?: number;
  note?: string;
};

export type Imaging = {
  enabled: boolean;
  /** The image model the director and the buttons draw with (models.ts AGENT_IMAGE_MODELS); unset on
      older projects, which drew with GPT Image through `backend`. */
  model?: string;
  /** LoRAs the director's pictures load with that model (models on the GPU pod; trained for its family). */
  loras?: Array<{ id: string; strength?: number }>;
  /** Agent use Canvas: the director may compose characters from the Canvas reference library over MCP
      (compose_character), with the model above. Off unless the user switches it on (web only). */
  agentCanvas?: boolean;
  /** The painter backend of that model: codex = the user's ChatGPT plan through the Codex CLI on a
      painter; api = OPENAI_API_KEY, paid per call; qwen = Qwen-Image 3.0 Pro's API; comfy:<model> = the GPU pod. */
  backend: string;
  maxImages: number;
  usedImages: number;
  quality: "low" | "medium" | "high";
  /** A fresh Codex session checks every drawn picture against its brief and refs (default on; uses Codex usage, not image quota). */
  selfCheck?: boolean;
  /** Redraws a painter may make when the self-check finds a blocker (0–2, default 1; each counts as a picture). */
  autoRedraws?: number;
  grantedBy: string;
  grantedAt: number;
  /** Set when the plan or the account ran out of image quota; painting stops until it is cleared. */
  stoppedReason?: string;
};

export type Delegation = {
  script: boolean;
  shotlist: boolean;
  grantedBy: string;
  grantedAt: number;
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
  /** Pictures only: a short per-project number (IMG-12 is seq 12) to name it by in a conversation. */
  seq?: number;
  /** `IMG-<seq>`, derived. */
  handle?: string;
  /** A readable name ("Mia · front"); the user can change it. */
  name?: string;
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
  /** Details that must never move or vanish; restated in every shot. */
  fixedFeatures?: FixedFeature[];
  /** Which view each reference image shows, by asset id. */
  refViews?: Record<string, RefView>;
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
  palette?: ScenePalette;
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

export type Review = {
  score: number; notes: string; by: "human" | "agent"; at: number;
  faults?: TakeFault[];
  /** false = the take's own audio failed review; the timeline mutes it. */
  audioOk?: boolean;
  /** For agent reviews: what was actually inspected (stills only — motion and sound unchecked). */
  basis?: string;
};

/** A cold-reader review of a stage, stored against a hash of what was reviewed. */
export type ReviewStage = "story" | "shot" | "film" | "frame";
export type ReviewFinding = { where: string; problem: string; fix?: string; sure?: boolean; severity?: "blocker" | "minor"; code?: string };
export type StageReview = {
  id: string; projectId: string; stage: ReviewStage; shotId?: string;
  subjectHash: string; verdict: "pass" | "fail"; reviewer: "fresh_agent" | "self" | "human"; basis: string;
  findings: ReviewFinding[]; createdAt: number;
};

/** The requirements list (everything the user asked for) and the decision log. */
export type NoteKind = "requirement" | "decision";
export type DirectorNote = {
  id: string; projectId: string; kind: NoteKind; status: string;
  body: Record<string, unknown>; createdAt: number; updatedAt: number;
};

/** What the pod reports while a take renders. */
export type TakeProgress = {
  stage: "inputs" | "queued" | "preparing" | "loading" | "sampling" | "decoding" | "finishing" | "uploading" | "error" | "interrupted" | string;
  step?: number; total?: number; percent?: number; secondsPerStep?: number; etaSeconds?: number; node?: string; at?: number;
};

export const UPSCALE_RESOLUTIONS = ["1080p", "2k", "4k"] as const;
export type UpscaleResolution = (typeof UPSCALE_RESOLUTIONS)[number];

/** Open-H3-Regenerate-2K pass on a completed take. */
export type TakeUpscale = {
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  resolution: UpscaleResolution;
  startSigma: number;
  requestId?: string;
  url?: string;
  thumbUrls?: string[];
  executionMs?: number;
  costUsd?: number;
  error?: string;
  progress?: TakeProgress;
  createdAt: number;
  finishedAt?: number;
};

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
  progress?: TakeProgress;
  upscale?: TakeUpscale;
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
  /** The model family it was trained for (models.ts). */
  baseModel: string;
  /** Settings stored for it; `recommended` adds what the Studio knows from its card and its stepsHint. */
  params: InferenceParams;
  recommended: InferenceParams;
  /** Made to draw adult content (models.ts isAdultLora): needs the user's 18+ switch, never with an uploaded picture. */
  adult: boolean;
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

export type JobKind = "hero-frames" | "element-refs" | "image";
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
  /** What the job was asked to draw (image jobs). */
  input: Record<string, unknown>;
  /** What the pod answered (urls, size, attempts). */
  output?: Record<string, unknown>;
  /** Image jobs: when a painter took it, and how many times it was taken. */
  claimedAt?: number;
  attempts?: number;
  createdAt: number;
  finishedAt?: number;
};

/** A RunPod CPU pod the Studio created for the painter: created when pictures wait, terminated when idle. */
export type PainterPod = {
  id: string;
  name: string;
  status: "running" | "starting" | "terminated" | "unavailable";
  message?: string;
  costPerHr?: number;
  startedAt?: number;
  stoppedAt?: number;
  lastActivityAt?: number;
  accumulatedSeconds: number;
  createdAt: number;
};

/** A machine that draws the Studio's pictures (workers/painter/painter.py). */
export type Painter = {
  id: string;
  name: string;
  info: {
    version?: string;
    host?: string;
    /** Paint backends it can serve right now (codex only once logged in, api only with a key). */
    backends?: string[];
    ops?: string[];
    /** Optional job inputs it understands (mirror_refs: flip a reference left to right). */
    features?: string[];
    slots?: number;
    running?: string[];
    onPod?: boolean;
    /** Random per process: two processes heartbeating under one id show up as a clash. */
    instance?: string;
    /** RUNPOD_POD_ID of the pod it runs in, when it runs on RunPod (links it to the painter pod). */
    runpodPodId?: string;
    codex?: { installed?: boolean; logged_in?: boolean; code_mode_host?: boolean; detail?: string; home?: string; bin?: string; version?: string };
    login?: { state: string; url?: string; code?: string; lines?: string[]; error?: string };
    lastError?: string;
  };
  commands: Array<{ id: string; type: "codex_login"; at: number }>;
  firstSeenAt: number;
  lastSeenAt: number;
};

export type Actor = { user: string; via: "web" | "mcp" | "hook" };
