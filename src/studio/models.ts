/*
 * Every model the Studio runs, and the inference settings its authors
 * recommend. Picking a model (or a LoRA trained for it) is enough: the
 * steps, CFG, sampler, schedule and shift follow from here, and a user
 * override is the exception, with a warning when it leaves the recipe.
 *
 *   base model params → per-workflow variant → speed LoRA → user override
 *
 * Two runtimes. "api": drawn by a painter through a hosted service (GPT
 * Image via Codex or the images API). "pod": a ComfyUI workflow on the GPU
 * pod — the same pod as the video models, so it draws only while the pod
 * runs. Pure data and functions: the pages import it too.
 */

export type ModelKind = "image" | "video";
export type ModelRuntime = "api" | "pod";

export type InferenceParams = {
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  /** A fixed schedule (distilled models): the steps are its length − 1. */
  sigmas?: number[];
  shiftVideo?: number;
  shiftAudio?: number;
  /** LoRAs: the strength to start at, and the range the author suggests. */
  strength?: number;
  strengthRange?: [number, number];
  /** Image models: the pixel budget reference pictures are resized to. */
  resolution?: number;
};

export type ModelFile = { dir: string; file: string; url: string; gb: number };

export type ModelEntry = {
  id: string;
  kind: ModelKind;
  runtime: ModelRuntime;
  label: string;
  zh: string;
  /** LoRAs say which family they were trained for. */
  family: string;
  /** Image models: the painter backend that draws them. */
  backend?: string;
  /** Pod workflows the model runs in. */
  workflows?: string[];
  params: InferenceParams;
  /** Settings a workflow changes (H3 R2VA wants the beta scheduler on the base chain). */
  variants?: Record<string, InferenceParams>;
  /** The chain the pod's graphs carry when nothing is sent (H3: the turbo chain). */
  graphDefaults?: InferenceParams;
  /** Image models: reference pictures per call, and how the prompt names them. */
  maxRefs?: number;
  refStyle?: "zh" | "qwen";
  files?: ModelFile[];
  license: string;
  commercial: boolean | "ask";
  /** Who refuses what: the hosted service's moderation, or nothing but the prompt. */
  moderation: "openai" | "none";
  source: string;
  notes: string;
};

/* Qwen-Image-2.1-Turbo's own 8-step schedule (scheduler_config / the ComfyUI template). */
export const QWEN21_TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0];

export const MODELS: ModelEntry[] = [
  {
    id: "gpt-image-codex", kind: "image", runtime: "api", label: "GPT Image · Codex", zh: "GPT Image（ChatGPT 套餐）", family: "gpt-image",
    backend: "codex", params: {}, maxRefs: 5, refStyle: "zh", license: "OpenAI terms of use", commercial: true, moderation: "openai",
    source: "https://platform.openai.com/docs/guides/image-generation",
    notes: "Drawn on a painter with Codex on the user's ChatGPT plan; counts against the plan's image usage. OpenAI moderates every request: sexual content is refused, and refusals are recorded on the account.",
  },
  {
    id: "gpt-image-api", kind: "image", runtime: "api", label: "GPT Image · API", zh: "GPT Image（API 按张计费）", family: "gpt-image",
    backend: "api", params: {}, maxRefs: 5, refStyle: "zh", license: "OpenAI terms of use", commercial: true, moderation: "openai",
    source: "https://platform.openai.com/docs/guides/image-generation",
    notes: "Drawn on a painter with OPENAI_API_KEY (IMAGE_MODEL, default gpt-image-2); paid per picture. Same moderation as Codex.",
  },
  {
    id: "qwen-image-2.1-turbo", kind: "image", runtime: "pod", label: "Qwen-Image 2.1 Turbo", zh: "通义 Qwen-Image 2.1 Turbo（GPU pod）", family: "qwen-image-2.1",
    backend: "comfy:qwen-image-2.1-turbo", workflows: ["QWEN21_EDIT"],
    params: { steps: 8, cfg: 1, sampler: "euler", sigmas: QWEN21_TURBO_SIGMAS, resolution: 1024 },
    maxRefs: 10, refStyle: "qwen",
    files: [
      { dir: "diffusion_models", file: "qwen_image_2.1_turbo_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_turbo_int8_convrot.safetensors", gb: 7.3 },
      { dir: "text_encoders", file: "qwen3vl_8b_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors", gb: 9.4 },
      { dir: "vae", file: "qwen_image_2.1_vae_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors", gb: 0.7 },
    ],
    license: "Qwen Research License: non-commercial (research or evaluation) only; a commercial license is requested from Qwen", commercial: false, moderation: "none",
    source: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1",
    notes: "Qwen's distilled 8-step edit model, multi-reference (up to 10 pictures, named <image1>…<image10> in the prompt), on the GPU pod in ComfyUI (the official Turbo image-edit template: TextEncodeQwenImage21, QwenImage21Cache, the fixed 8-step sigma schedule, CFG 1, euler). No content filter of its own. The 'Uncensored' Qwen3-VL text encoder (AtomicChat) is a stable-diffusion.cpp GGUF not run in ComfyUI, and its card measures no change to the pictures; the stock encoder is used.",
  },
  {
    id: "minimax-h3", kind: "video", runtime: "pod", label: "MiniMax H3", zh: "MiniMax H3 视频", family: "minimax-h3",
    workflows: ["T2VA", "I2VA", "FL2VA", "R2VA"],
    /* the base chain (HANDOFF §3); a speed LoRA replaces it */
    params: { steps: 20, sampler: "res_multistep", scheduler: "simple", shiftVideo: 1, shiftAudio: 1 },
    variants: { R2VA: { scheduler: "beta" } },
    graphDefaults: { steps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 6, shiftAudio: 3 },
    license: "MiniMax Community License (excludes deployments in the US, EU, UK and South Korea)", commercial: "ask", moderation: "none",
    source: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    notes: "Video with sound, 768p, 5–15 s per take. Without a speed LoRA: the base chain at 20 steps. With a turbo LoRA (lightx2v): 8 steps, euler/simple, sigma shift 6 video / 3 audio — about 2.5× faster.",
  },
  {
    id: "open-h3-regenerate-2k", kind: "video", runtime: "pod", label: "Open-H3-Regenerate-2K", zh: "H3 2K 重生成", family: "minimax-h3",
    workflows: ["REGEN"], params: { steps: 3 },
    license: "NVIDIA open model license (see the model card)", commercial: "ask", moderation: "none",
    source: "https://huggingface.co/Efficient-Large-Model/Open-H3-Regenerate-2K",
    notes: "Re-generates a finished 768p take at 1080p / 2K / 4K in three refine steps. Start sigma 0 redraws more (sharper); 0.8 stays close to the draft (character shots).",
  },
  {
    id: "viggle-remake", kind: "video", runtime: "pod", label: "Viggle Remake", zh: "Viggle Remake 局部重拍", family: "minimax-h3",
    workflows: ["REMAKE"], params: {},
    license: "Apache-2.0 (nodes); model weights per the Viggle card", commercial: "ask", moderation: "none",
    source: "https://huggingface.co/Viggle/Viggle-Remake",
    notes: "Re-shoots a take from one or two painted keyframes, keeping its motion, camera, timing and sound. Settings come with the workflow.",
  },
];

export const IMAGE_MODELS = MODELS.filter((m) => m.kind === "image");
export const DEFAULT_IMAGE_MODEL = "gpt-image-codex";

export function findModel(id: string): ModelEntry | undefined {
  return MODELS.find((m) => m.id === id);
}

/** The image model a painter backend draws ("codex" → GPT Image · Codex). */
export function imageModelOfBackend(backend: string): ModelEntry | undefined {
  return IMAGE_MODELS.find((m) => m.backend === backend);
}

/* ---------- LoRAs ---------- */

/** What the Studio knows about the LoRAs it seeds (migrations 0005, 0007), from their model cards; a user's own values win. */
export const KNOWN_LORA_PARAMS: Record<string, InferenceParams> = {
  lora_h3_turbo_fl2v: { steps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 6, shiftAudio: 3, strength: 1 },
  lora_h3_turbo_ref2v: { steps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 6, shiftAudio: 3, strength: 1 },
  lora_fal_realism_people: { strength: 0.8, strengthRange: [0.6, 1] },
  lora_jojocodex_camera: { strength: 0.6, strengthRange: [0.5, 0.7] },
  lora_jojocodex_physics: { strength: 0.4, strengthRange: [0.3, 0.5] },
  lora_prithiv_facial_closeup: { strength: 0.6 },
  lora_prithiv_anime_motion: { strength: 0.8 },
  lora_innerreflections_sketch_loop: { strength: 1, strengthRange: [0.75, 1.25] },
  lora_diffsynth_lineart_anime: { strength: 1 },
};

export type LoraLike = { id: string; name: string; kind: string; stepsHint?: number; defaultStrength?: number; params?: InferenceParams; strength?: number };

/** A LoRA's recommended settings: what it was seeded with, then what the user stored, then its stepsHint. */
export function loraParams(l: LoraLike): InferenceParams {
  const p: InferenceParams = { ...(KNOWN_LORA_PARAMS[l.id] ?? {}), ...stripEmpty(l.params ?? {}) };
  if (p.steps === undefined && l.stepsHint) p.steps = l.stepsHint;
  if (p.strength === undefined && l.defaultStrength !== undefined) p.strength = l.defaultStrength;
  return p;
}

function stripEmpty(p: InferenceParams): InferenceParams {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== "")) as InferenceParams;
}

/* ---------- resolving ---------- */

export type Resolved = { params: InferenceParams; sources: string[]; warnings: string[] };

const SAMPLING_KEYS = ["steps", "cfg", "sampler", "scheduler", "sigmas", "shiftVideo", "shiftAudio"] as const;

/**
 * The settings a render uses. The base model's recommendation, its
 * workflow variant, then the speed LoRA (it replaces the sampling chain it
 * was distilled for), then the caller's steps. A model with a fixed sigma
 * schedule takes its steps from the schedule.
 */
export function resolveParams(model: ModelEntry, opts: { workflow?: string; loras?: LoraLike[]; steps?: number } = {}): Resolved {
  const warnings: string[] = [];
  const sources = [model.label];
  let params: InferenceParams = { ...model.params, ...(opts.workflow ? model.variants?.[opts.workflow] ?? {} : {}) };
  const speed = (opts.loras ?? []).find((l) => l.kind === "speed");
  if (speed) {
    const lp = loraParams(speed);
    const chain = Object.fromEntries(SAMPLING_KEYS.filter((k) => lp[k] !== undefined).map((k) => [k, lp[k]])) as InferenceParams;
    /* a speed LoRA that only knows its steps runs on the chain the graphs carry for it */
    params = { ...params, ...(model.graphDefaults ?? {}), ...chain };
    if (!chain.sigmas) delete params.sigmas;
    sources.push(speed.name);
  }
  if (opts.steps !== undefined && opts.steps !== params.steps) {
    if (params.sigmas) {
      warnings.push(`${sources.at(-1)} runs on a fixed ${params.sigmas.length - 1}-step schedule; ${opts.steps} steps was ignored`);
    } else {
      warnings.push(speed ? `${speed.name} is tuned for ${params.steps} steps; you asked for ${opts.steps}` : `${model.label} wants about ${params.steps} steps, not ${opts.steps}`);
      params = { ...params, steps: opts.steps };
      sources.push("your steps");
    }
  }
  if (params.sigmas) params.steps = params.sigmas.length - 1;
  for (const l of opts.loras ?? []) {
    const lp = loraParams(l);
    if (l.strength !== undefined && lp.strengthRange && (l.strength < lp.strengthRange[0] || l.strength > lp.strengthRange[1])) {
      warnings.push(`${l.name} at ${l.strength}: its card suggests ${lp.strengthRange[0]}–${lp.strengthRange[1]}`);
    }
  }
  return { params, sources, warnings };
}

/** True when the settings equal the chain the pod's graphs already carry (nothing to send). */
export function isGraphDefault(model: ModelEntry, p: InferenceParams): boolean {
  const g = model.graphDefaults;
  if (!g) return false;
  return (["sampler", "scheduler", "shiftVideo", "shiftAudio"] as const).every((k) => g[k] === p[k]);
}

/** "8 steps · euler/simple · shift 6/3 · CFG 1" */
export function describeParams(p: InferenceParams): string {
  const parts: string[] = [];
  if (p.steps !== undefined) parts.push(`${p.steps} steps${p.sigmas ? " (fixed schedule)" : ""}`);
  if (p.sampler) parts.push(p.scheduler ? `${p.sampler}/${p.scheduler}` : p.sampler);
  else if (p.scheduler) parts.push(`${p.scheduler} scheduler`);
  if (p.shiftVideo !== undefined) parts.push(`shift ${p.shiftVideo}${p.shiftAudio !== undefined ? `/${p.shiftAudio}` : ""}`);
  if (p.cfg !== undefined) parts.push(`CFG ${p.cfg}`);
  if (p.strengthRange) parts.push(`strength ${p.strengthRange[0]}–${p.strengthRange[1]}`);
  else if (p.strength !== undefined) parts.push(`strength ${p.strength}`);
  return parts.join(" · ");
}
