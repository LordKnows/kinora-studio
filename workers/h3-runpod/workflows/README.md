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

`T2VA.json` here is a placeholder whose node ids match the example
`mapping.json`, so the unit tests can exercise the fill logic. It will not run
on a real ComfyUI.

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
