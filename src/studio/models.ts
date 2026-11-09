/*
 * Every model the Studio runs, and the inference settings its authors
 * recommend. Picking a model (or a LoRA trained for it) is enough: the
 * steps, CFG, sampler, schedule and shift follow from here, and a user
 * override is the exception, with a warning when it leaves the recipe.
 *
 *   base model params → per-workflow variant → speed LoRA → user override
 *
 * Two runtimes. "api": drawn by a painter through a hosted service (GPT
 * Image via Codex or the images API; Qwen-Image 3.0 Pro through TokenSail
 * or DashScope, on the CPU painter pod). "pod": a ComfyUI workflow on the GPU
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
  /** Canvas recipes it can draw: a pose plus a portrait and/or a costume, nothing else (Qwen-Image-Edit 2509's fixed slots). */
  poseRecipe?: boolean;
  /** The size its pictures come at whatever was picked (2509: the canvas follows the pose picture, 3:4 like every library pose). */
  canvasSize?: "1008x1344";
  /** API models: the vendor's model name, and the request options Canvas offers (the pose gallery's 百炼 settings). */
  apiModel?: string;
  options?: Array<"prompt_extend" | "negative_prompt">;
  files?: ModelFile[];
  license: string;
  commercial: boolean | "ask";
  /** Who refuses what: the hosted service's moderation, or nothing but the prompt. */
  moderation: "openai" | "alibaba" | "none";
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
    id: "qwen-image-3.0-pro", kind: "image", runtime: "api", label: "Qwen-Image 3.0 Pro · API", zh: "通义 Qwen-Image 3.0 Pro（API，按张计费）", family: "qwen-image-3.0",
    backend: "qwen", apiModel: "qwen-image-3.0-pro", params: {}, maxRefs: 3, refStyle: "zh", options: ["prompt_extend", "negative_prompt"],
    license: "Alibaba Cloud Model Studio terms, through TokenSail (or DashScope directly); paid per picture and per reference picture", commercial: "ask", moderation: "alibaba",
    source: "https://tokensail.ai/docs/api/images.html",
    notes: "The pose gallery's 阿里云百炼 path (anhao/ai-pose-gallery-zh: qwen-image-3.0-pro, references as URLs, 图1/图2/图3 in the prompt, prompt_extend, watermark off, negative prompt). Drawn by the CPU painter pod with TOKENSAIL_API_KEY (TokenSail's /v1/images/generations) or DASHSCOPE_API_KEY (DashScope's multimodal-generation); no GPU. The vendor fetches the references itself, so the painter puts them in R2 for the job's length. TokenSail lists ¥0.25 per picture at 1K and ¥0.50 at 2K, each reference billed on top; cn region only. Alibaba Cloud moderates every request: sexual content is refused.",
  },
  {
    id: "qwen-image-2.1-turbo", kind: "image", runtime: "pod", label: "Qwen-Image 2.1 Turbo", zh: "通义 Qwen-Image 2.1 Turbo（GPU pod）", family: "qwen-image-2.1-turbo",
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
    notes: "Qwen's distilled 8-step edit model, multi-reference (up to 10 pictures, named <image1>…<image10> in the prompt), on the GPU pod in ComfyUI (the official Turbo image-edit template: TextEncodeQwenImage21, QwenImage21Cache, the fixed 8-step sigma schedule, CFG 1, euler). No content filter of its own. LoRAs trained for the base model (Qwen-Image 2.1) are not offered here: use the base model for them. The 'Uncensored' Qwen3-VL text encoder (AtomicChat) is a stable-diffusion.cpp GGUF not run in ComfyUI, and its card measures no change to the pictures; the stock encoder is used.",
  },
  {
    id: "qwen-image-2.1", kind: "image", runtime: "pod", label: "Qwen-Image 2.1", zh: "通义 Qwen-Image 2.1 基础版（GPU pod，可加 LoRA）", family: "qwen-image-2.1",
    backend: "comfy:qwen-image-2.1", workflows: ["QWEN21_EDIT_BASE"],
    /* the official pipeline: about 40–50 euler steps at CFG 1 (Comfy-Org's template starts at 25); a LoRA's own card wins */
    params: { steps: 40, cfg: 1, sampler: "euler", scheduler: "simple", resolution: 1024 },
    maxRefs: 10, refStyle: "qwen",
    files: [
      { dir: "diffusion_models", file: "qwen_image_2.1_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/diffusion_models/qwen_image_2.1_int8_convrot.safetensors", gb: 7.3 },
      { dir: "text_encoders", file: "qwen3vl_8b_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/text_encoders/qwen3vl_8b_int8_convrot.safetensors", gb: 9.4 },
      { dir: "vae", file: "qwen_image_2.1_vae_bf16.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1/resolve/main/vae/qwen_image_2.1_vae_bf16.safetensors", gb: 0.7 },
    ],
    license: "Qwen Research License: non-commercial (research or evaluation) only; a commercial license is requested from Qwen", commercial: false, moderation: "none",
    source: "https://huggingface.co/Comfy-Org/Qwen-Image-2.1",
    notes: "The full (not distilled) Qwen-Image 2.1, for LoRAs trained on it — e.g. ChatR Labs' Omni LoRA (35 steps, CFG 5). Comfy-Org's image-edit template: KSampler, euler/simple, up to ten pictures (<image1>…). Slower than Turbo: about 4–5× the steps, and CFG above 1 runs each step twice. The text encoder and VAE are shared with Turbo; the base adds 7.3 GB on the pod.",
  },
  {
    id: "qwen-image-edit-2509", kind: "image", runtime: "pod", label: "Qwen-Image-Edit 2509", zh: "通义 Qwen-Image-Edit 2509 三图合成（GPU pod，Lightning 4 步）", family: "qwen-image-edit-2509",
    backend: "comfy:qwen-image-edit-2509", workflows: ["QIE2509_3IMG", "QIE2509_2IMG"],
    /* the Lightning 4-step LoRA is part of the workflow: 4 steps, CFG 1, euler/simple, shift 3 (anhao/ai-pose-gallery-zh's graph) */
    params: { steps: 4, cfg: 1, sampler: "euler", scheduler: "simple" },
    maxRefs: 3, refStyle: "zh", poseRecipe: true, canvasSize: "1008x1344",
    files: [
      { dir: "diffusion_models", file: "qwen_image_edit_2509_fp8_e4m3fn.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image-Edit/resolve/main/split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors", gb: 20.4 },
      { dir: "text_encoders", file: "qwen_2.5_vl_7b_fp8_scaled.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors", gb: 9.4 },
      { dir: "vae", file: "qwen_image_vae.safetensors", url: "https://huggingface.co/Comfy-Org/Qwen-Image/resolve/main/split_files/vae/qwen_image_vae.safetensors", gb: 0.25 },
      { dir: "loras", file: "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors", url: "https://huggingface.co/lightx2v/Qwen-Image-Lightning/resolve/main/Qwen-Image-Edit-2509/Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors", gb: 0.85 },
    ],
    license: "Apache-2.0 (Qwen-Image-Edit 2509, Comfy-Org's repackage, lightx2v Lightning)", commercial: true, moderation: "none",
    source: "https://huggingface.co/Qwen/Qwen-Image-Edit-2509",
    notes: "The ComfyUI workflow the pose gallery recommends (anhao/ai-pose-gallery-zh, qwen_image_edit_2509_3img): 图1 portrait and 图2 costume are pixel references (ReferenceLatent), 图3 pose reaches the model only through the text encoder, so the grey mannequin's look never comes through. Lightning 4-step LoRA, shift 3, CFGNorm, KSampler euler/simple, CFG 1. Needs a pose and a portrait and/or a costume (two pictures: person + pose; three: portrait + costume + pose), no extra pictures. As in the original, the canvas takes the pose picture's aspect (3:4 at about 1 MP; the picture is delivered at 1008×1344): a canvas the costume picture's shape (2:3) makes it redraw the costume picture in place. The pose steers only through the text encoder, so it is followed loosely, more so at 4 Lightning steps. About 31 GB on the pod.",
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

/** Image models the director may draw with (Settings → Director): all of them but a fixed-slot pose
    recipe (Qwen-Image-Edit 2509 only composes portrait / costume + pose: Canvas). */
export const AGENT_IMAGE_MODELS = IMAGE_MODELS.filter((m) => !m.poseRecipe);

/** The model a project's pictures are drawn with: the one chosen in Settings, else the GPT Image
    backend the project had before models could be chosen (codex / api). */
export function projectImageModel(imaging?: { model?: string; backend?: string } | null): ModelEntry {
  const chosen = imaging?.model ? AGENT_IMAGE_MODELS.find((m) => m.id === imaging.model) : undefined;
  return chosen ?? AGENT_IMAGE_MODELS.find((m) => m.backend === (imaging?.backend ?? "codex")) ?? AGENT_IMAGE_MODELS[0]!;
}

/** The Studio's prompts name their pictures "Picture 1", "Picture 2" …; a model that reads them as
    tokens (Qwen-Image 2.1: <image1> …) gets those instead. */
export function namePicturesFor(model: ModelEntry, prompt: string): string {
  return model.refStyle === "qwen" ? prompt.replace(/\b[Pp]icture (\d+)\b/g, "<image$1>") : prompt;
}

/** What an agent picture sends with the job: the model's recommended settings (pod models), or the
    vendor's model name (API models). GPT Image takes none. */
export function defaultImageParams(model: ModelEntry): (InferenceParams & { api_model?: string; prompt_extend?: boolean }) | undefined {
  if (model.runtime === "pod") return resolveParams(model).params;
  if (model.apiModel) return { api_model: model.apiModel, prompt_extend: false };
  return undefined;
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
  /* ChatR Labs Omni v0.1 for Qwen-Image 2.1 (migration 0017): its card's evaluation settings */
  lora_chatr_omni_v01: { steps: 35, cfg: 5, strength: 1 },
};

/** LoRAs made to draw adult content: hidden until the user has unlocked 18+, and never with an uploaded picture (a real person). */
export const ADULT_LORA_IDS = new Set(["lora_chatr_omni_v01"]);

export function isAdultLora(l: { id: string; name: string; filename?: string }): boolean {
  return ADULT_LORA_IDS.has(l.id) || /uncensor|nsfw|18\+|\bnude|\bporn/i.test(`${l.name} ${l.filename ?? ""}`);
}

export type LoraLike = { id: string; name: string; kind: string; stepsHint?: number; defaultStrength?: number; params?: InferenceParams; strength?: number };

/** A LoRA's recommended settings: what it was seeded with, then what the user stored, then (speed LoRAs) its stepsHint. */
export function loraParams(l: LoraLike): InferenceParams {
  const p: InferenceParams = { ...(KNOWN_LORA_PARAMS[l.id] ?? {}), ...stripEmpty(l.params ?? {}) };
  if (p.steps === undefined && l.stepsHint && l.kind === "speed") p.steps = l.stepsHint;
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
 * was distilled for) — or, without one, the first LoRA whose card names
 * its own steps or CFG (Omni: 35 steps, CFG 5) — then the caller's steps.
 * A model with a fixed sigma schedule takes its steps from the schedule.
 */
export function resolveParams(model: ModelEntry, opts: { workflow?: string; loras?: LoraLike[]; steps?: number } = {}): Resolved {
  const warnings: string[] = [];
  const sources = [model.label];
  let params: InferenceParams = { ...model.params, ...(opts.workflow ? model.variants?.[opts.workflow] ?? {} : {}) };
  const chainOf = (l: LoraLike) => Object.fromEntries(SAMPLING_KEYS.filter((k) => loraParams(l)[k] !== undefined).map((k) => [k, loraParams(l)[k]])) as InferenceParams;
  const speed = (opts.loras ?? []).find((l) => l.kind === "speed");
  const carrier = speed ?? (opts.loras ?? []).find((l) => Object.keys(chainOf(l)).length > 0);
  if (carrier) {
    const chain = chainOf(carrier);
    /* a speed LoRA that only knows its steps runs on the chain the graphs carry for it */
    params = { ...params, ...(speed ? model.graphDefaults ?? {} : {}), ...chain };
    if (!chain.sigmas) delete params.sigmas;
    sources.push(carrier.name);
    const others = (opts.loras ?? []).filter((l) => l !== carrier && Object.keys(chainOf(l)).length > 0 && l.kind !== "speed");
    if (others.length) warnings.push(`${others.map((l) => l.name).join(", ")} also name${others.length > 1 ? "" : "s"} settings; ${carrier.name}'s are used`);
  }
  if (opts.steps !== undefined && opts.steps !== params.steps) {
    if (params.sigmas) {
      warnings.push(`${sources.at(-1)} runs on a fixed ${params.sigmas.length - 1}-step schedule; ${opts.steps} steps was ignored`);
    } else {
      warnings.push(carrier ? `${carrier.name} is tuned for ${params.steps} steps; you asked for ${opts.steps}` : `${model.label} wants about ${params.steps} steps, not ${opts.steps}`);
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
