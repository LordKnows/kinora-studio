# Workflow templates

The handler does not contain a MiniMax H3 graph. It fills whatever API-format
ComfyUI graph you put here.

1. In ComfyUI (≥ 0.30.0, with the Comfy-Org H3 models on the network volume)
   open the H3 templates for text-to-video, image-to-video, first/last-frame
   and reference-to-video. Run each once so every node has valid defaults.
2. Enable *Dev mode* in ComfyUI settings and use **Save (API Format)**. Save as
   `T2VA.json`, `I2VA.json`, `FL2VA.json`, `R2VA.json` in this directory.
3. Open each file and note the node ids of: the positive and negative text
   encoders, the sampler (seconds / width / height / steps / seed), the
   LoadImage nodes for first frame, last frame and reference slots, the
   LoadVideo node (R2VA edit), the optional prompt-enhance node, and the
   SaveVideo node. Write them into `mapping.json`.
4. `python3 handler.py --local '{"action":"health"}'` lists the templates the
   handler sees; run a tiny T2VA job to confirm the mapping.

The four JSONs here are the handoff's graphs as they rendered on an A100
(`docs/handoff/HANDOFF.md`, verified by `docs/handoff/verify_handoff.py`);
`mapping.json` is checked against every node they contain.

Facts from the handoff that the handler relies on:

- `104.length` is a **frame count** of the form 17k+5 at 24 fps (124 ≈ 5.2 s,
  243 ≈ 10.1 s, documented range 124–362); the handler converts `seconds`.
- There is no negative prompt input (BasicGuider, no CFG); constraints go into
  the prompt text.
- Steps live on `9.steps` and must match the turbo LoRA (8); seed on
  `15.noise_seed`; width/height on `104` must be multiples of 32.
- One LoRA slot: `7` (LoraLoaderModelOnly, `lora_name` + `strength_model`).
  T2VA/I2VA/FL2VA use the fl2v turbo LoRA and the fl2va base model; R2VA uses
  the ref2v turbo LoRA and the ref2va base model (node `6.unet_name`).
- R2VA ships with two LoadImage slots (`201`, `202` → `104.ref_images.ref_image_0/1`);
  the node accepts up to `ref_image_8` — add LoadImage nodes and list them under
  `reference_images` to allow more. `104.ref_image_size` stays `match`.
- `92` (SaveVideo) reports its mp4 under `images` in `/history`.
- The prompt is lightx2v's structured format (the Studio compiles it): see
  `src/studio/compiler.ts` `H3_PROMPT_FORMAT`.

Field semantics:

| mapping field | job value |
|---|---|
| `prompt`, `negative` | compiled prompt text; negative constraints |
| `seconds` | clip length 5–15 |
| `width`, `height` | from `video_size` (768p presets) |
| `steps`, `seed` | sampling |
| `enhance` | boolean for an optional Qwen prompt-enhance node (ignored if absent) |
| `first_frame`, `last_frame` | uploaded filename for LoadImage |
| `reference_images` | list of targets, one per reference slot (≤ 3) |
| `video` | uploaded filename of the source clip (edit mode) |
| `output_node` | the SaveVideo node whose output the handler downloads |
| `timeout_s` | how long to wait for ComfyUI before failing the job |

## LoRAs

`mapping.json` lists the LoraLoader nodes of each graph under `loras`, in
priority order: `{"node": "12", "name": "lora_name", "strength": "strength_model",
"strength_clip": "strength_clip"}`. The Studio sends `loras: [{file, strength,
hf_url}]`; the handler fills the slots in order and sets unused slots to
strength 0. Files are read from `LORA_DIR` (default
`/workspace/ComfyUI/models/loras`); a missing file is downloaded from its
`hf_url` first (set `HF_TOKEN` on the pod for gated repos). Put the LoRA
loaders in the graph where ComfyUI's H3 template expects them (between the
model loader and the sampler) and keep a speed LoRA as slot 1.
