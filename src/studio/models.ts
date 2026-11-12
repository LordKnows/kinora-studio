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
 * runs (MiniMax-H3-Image, the open weights of 2026-11-10). Pure data and
 * functions: the pages import it too.
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
  /** Image models: the side of the square whose area the model draws at before the picture is resized
      to the asked size (MiniMax-H3-Image: 2048 = 4 MP, 4096 = 16 MP). */
  resolution?: number;
};

/** How a model's prompt names its reference pictures: 图1 / "Picture 1" (GPT Image, the Qwen API)
    or <Picture 1> (MiniMax-H3-Image). */
export type RefStyle = "zh" | "h3";

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
  refStyle?: RefStyle;
  /** The language Canvas composes its prompt in when the user has not chosen one: the Chinese template
      unless the model follows English best (MiniMax-H3-Image). */
  promptLang?: "zh" | "en";
  /** The areas it can deliver a picture at beside the Studio sizes (Canvas → Resolution): a model with a
      working range of its own (MiniMax-H3-Image: about 4–20 MP). Unset: the Studio sizes only. */
  resolutions?: Array<"4mp" | "9mp" | "16mp">;
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
    id: "minimax-h3-image", kind: "image", runtime: "pod", label: "MiniMax H3 Image", zh: "MiniMax H3 Image（GPU pod，开源权重）", family: "minimax-h3-image",
    backend: "comfy:minimax-h3-image", workflows: ["H3_IMAGE"],
    /* the checkpoint is distilled to 6 steps without guidance (the model card: other values are refused by MiniMax's own server);
       resolution 2048 = drawn at 4 MP, the card's min_generation_area default, then resized to the asked size */
    params: { steps: 6, cfg: 1, sampler: "euler", scheduler: "simple", resolution: 2048 },
    maxRefs: 10, refStyle: "h3", promptLang: "en", resolutions: ["4mp", "9mp", "16mp"],
    files: [
      { dir: "diffusion_models", file: "minimax_h3_image_pruned_int8_convrot.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", gb: 21 },
      { dir: "text_encoders", file: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", gb: 15.7 },
      { dir: "vae", file: "minimax_h3_image_vae_fp16.safetensors", url: "https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/main/vae/minimax_h3_image_vae_fp16.safetensors", gb: 1.2 },
    ],
    license: "MiniMax-H3-Image Community License Agreement: not for use in the EU, the UK, South Korea or the US; a written authorization from MiniMax is needed above 1M USD of annual revenue or to host it for third parties, and a commercial product names MiniMax-H3-Image in its interface", commercial: "ask", moderation: "none",
    source: "https://huggingface.co/MiniMaxAI/MiniMax-H3-Image",
    notes: "MiniMax's open-weight image model of the H3 family (released 2026-11-10): text to image and multi-reference editing in one checkpoint, a 33B single-stream DiT (H3 without the audio layers) distilled to 6 steps without guidance. Self-hosted on the GPU pod in ComfyUI (v0.45.0 or later: MiniMaxH3ImageConditioning, KSampler 6 steps / CFG 1 / euler / simple; Comfy-Org's templates without their prompt-enhancer branch), not through MiniMax's API. It uses the MiniMax-H3 text encoder unchanged, the file the video graphs already load, so it adds 22 GB on the pod (int8 DiT + image VAE). Pictures are <Picture 1>…<Picture 10> in the prompt (the model takes 16; the Studio sends up to ten). Its working range is about 4–20 MP and it is weak below: a smaller request (a 1344×768 frame) is drawn on a canvas of the same shape at 4 MP and resized to the asked size, as MiniMax's server does. Canvas can also deliver the picture at the model's own resolution (Resolution: 4, 9 or 16 MP — the same shape, e.g. 16:9 at 5376×3072), drawn at that size and not resized; 16 MP is its best quality, several times slower and tens of MB a picture. It expects a detailed English description of the whole picture: the director's sectioned prompts fit, so Canvas composes its recipe in English for it by default (the language can be chosen there); MiniMax's API expands short prompts first, a step not run here. No negative prompt, no content filter of its own.",
  },
  {
    id: "minimax-h3", kind: "video", runtime: "pod", label: "MiniMax H3", zh: "MiniMax H3 视频", family: "minimax-h3",
    workflows: ["T2VA", "I2VA", "FL2VA", "R2VA"],
    /* the base chain (HANDOFF §3); a speed LoRA replaces it. The handoff's 20-step graph had no
       MiniMaxH3SigmaShift node, which leaves the model's own shift (ComfyUI supported_models:
       shift 12, audio_shift 3). Our graphs always carry the node, so the base chain sets it to
       those values; 1/1 would be no shift at all (too few steps at high noise: camera moves stutter). */
    params: { steps: 20, sampler: "res_multistep", scheduler: "simple", shiftVideo: 12, shiftAudio: 3 },
    variants: { R2VA: { scheduler: "beta" } },
    graphDefaults: { steps: 8, sampler: "euler", scheduler: "simple", shiftVideo: 6, shiftAudio: 3 },
    license: "MiniMax Community License (excludes deployments in the US, EU, UK and South Korea)", commercial: "ask", moderation: "none",
    source: "https://huggingface.co/Comfy-Org/MiniMax-H3",
    notes: "Video with sound, 768p, 5–15 s per take. Without a speed LoRA: the base chain at 20 steps, the model's own sigma shift (12 video / 3 audio). With a turbo LoRA (lightx2v): 8 steps, euler/simple, sigma shift 6 video / 3 audio — about 2.5× faster.",
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

/** Image models the director may draw with (the project's Director page): every one Canvas offers. */
export const AGENT_IMAGE_MODELS = IMAGE_MODELS;

/** The model a project's pictures are drawn with: the one chosen on the Director page, else the GPT Image
    backend the project had before models could be chosen (codex / api). */
export function projectImageModel(imaging?: { model?: string; backend?: string } | null): ModelEntry {
  const chosen = imaging?.model ? AGENT_IMAGE_MODELS.find((m) => m.id === imaging.model) : undefined;
  return chosen ?? AGENT_IMAGE_MODELS.find((m) => m.backend === (imaging?.backend ?? "codex")) ?? AGENT_IMAGE_MODELS[0]!;
}

/** The Studio's prompts name their pictures "Picture 1", "Picture 2" …; a model that reads them as
    tokens (MiniMax-H3-Image: <Picture 1> …) gets those instead. */
export function namePicturesFor(model: ModelEntry, prompt: string): string {
  /* a prompt that already carries the token (<Picture 1>) is left as it is */
  if (model.refStyle === "h3") return prompt.replace(/(?<!<)\b[Pp]icture (\d+)\b(?!>)/g, "<Picture $1>");
  return prompt;
}

/** The language a Canvas prompt is composed in: the one chosen, else the model's. */
export function canvasLangFor(model: ModelEntry, chosen?: "zh" | "en"): "zh" | "en" {
  return chosen ?? model.promptLang ?? "zh";
}

/** The longest side a model can draw a picture at: its own resolution for a model with a working range, the Studio's 4096 otherwise. */
export const MAX_PICTURE_SIDE = 4096;
export const MAX_PICTURE_SIDE_LARGE = 6400;

/** The size an edit of a picture is drawn at: the picture's own, brought within what the model draws
    (a 16 MP MiniMax H3 Image picture edited by another model comes back at most 4096 px on its long side). */
export function editSizeFor(model: ModelEntry, width: number, height: number): { size: string; reduced: boolean } {
  const cap = model.resolutions?.length ? MAX_PICTURE_SIDE_LARGE : MAX_PICTURE_SIDE;
  const scale = Math.min(1, cap / Math.max(width, height));
  const even = (v: number) => Math.max(64, Math.round((v * scale) / 2) * 2);
  return scale < 1 ? { size: `${even(width)}x${even(height)}`, reduced: true } : { size: `${width}x${height}`, reduced: false };
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
};

/** LoRAs made to draw adult content: hidden until the user has unlocked 18+, and never with an uploaded picture (a real person). */
export function isAdultLora(l: { id: string; name: string; filename?: string }): boolean {
  return /uncensor|nsfw|18\+|\bnude|\bporn/i.test(`${l.name} ${l.filename ?? ""}`);
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
 * its own steps or CFG — then the caller's steps.
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
