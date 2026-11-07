# Technique: the self-hosted H3 you are writing for

The implementation half of the guide. Nothing here is a directing rule; it is what the model and the assembler can and cannot do.

## Resolution, frame grid, durations

- 1344×768 at 24 fps is the verified resolution (the turbo LoRAs are 768p models). Other aspect ratios are untested.
- Durations snap to a frame grid: 5 s → 5.2 s, 10 s → 10.13 s, 12 s → 12.25 s, 15 s → 15.1 s (`compile_prompt` reports the exact `effectiveSeconds`). Stay on 5–15 s per shot; chain with `continuous` or `bridge` for longer action.
- Length and quality: one action per 5 s generation is the reliable unit; a two-beat 12 s shot asks one generation to carry a turn, which the model tends to average out. Measured cost: a 10 s take ran about 32 GPU-seconds per output second, a 12 s take about 121, so the per-second price roughly quadruples above 10 s. `plan_batch` uses `compile_prompt` estimates when given and this curve otherwise.
- One shot is one generation. Beats are time-stamped sub-descriptions inside that single prompt (`0–6s: … 6–12s: …`); a beat with `cut: true` asks the model for a hard cut inside the same clip (at most 3). Separate generations come only from separate shots and their links.
- Native stereo audio is generated with the picture from the sound fields (`sfx`, `ambience`, `music`).

## Modes and base models

- `text` (T2VA), `keyframe` (I2VA; FL2VA with an end frame), `reference` (R2VA: character sheets as `<Subject N>`, two slots by default, up to nine). Mutually exclusive per shot. There is no edit mode: re-render as a new take.
- Two base models: T2VA / I2VA / FL2VA share one, R2VA another; switching reloads ~2 minutes. `plan_batch` groups renders per base model and respects anchors (a linked shot renders only after its anchor has a finished take).

## Links (how a shot joins the earlier ones)

| type | mechanism | workflow | default anchor |
|---|---|---|---|
| `cut` | none | T2VA / I2VA / R2VA | — |
| `continuous` | anchor last frame as first frame | I2VA (FL2VA with an end frame) | −1 |
| `bridge` | anchor last frame → this shot's end frame | FL2VA | −1 |
| `insert_return` | resume the shot before the insert | I2VA | −2 |
| `reverse` | each speaker resumes from their own last frame | I2VA | −2 |
| `match_cut` | anchor last frame as reference image | R2VA | −1 |
| `jump_cut` | same setup, time has passed | I2VA | −1 |
| `montage` | standalone 5 s beat | any | — |
| `loop` | hero frame as first and last frame, `repeat` on the timeline | FL2VA | — |

Do not describe what the anchor frame already shows; describe what happens next. `match_cut` keeps subjects more reliably than composition; prefer `continuous` / `bridge` when the join must be exact.

## Writing shots

- Beats: one primary action each, tiling the duration exactly; at most 3 hard cuts inside a shot.
- One camera move per shot, with amplitude and speed; `static` compiles to a locked-off instruction (H3 drifts otherwise).
- Cinematography keys (size, angle, lens, dof, lighting, grade, texture, vfx, animation, pace) compile to prose; the project Look is injected into every shot's prompt, so the style's Look fields carry most of the style.
- `apply_style` appends the style's beat suffix to every beat so the medium is restated per shot; H3 forgets the Look in long beats otherwise.
- Dialogue: the verified clips used whispers and laughter; spoken lines are unverified. Keep them short or describe the vocal sound in `sound`.
- On-screen text: never ask the model; the local assembler adds titles, captions and OSD.

## Staging fields and what they compile to

- `blocking` → "Mia enters from frame left, then moves to frame right." lines; `composition` → "the subject's eyes sit on the left third, about 38% from the left edge"; a scene `palette` → "Scene palette #…" in the LOOK; an element's `fixedFeatures` → "Mia always has a dragon tattoo on the left forearm, in every frame", in every mode including keyframe.
- Reference images tagged with a view (`select_element_refs` views): R2VA picks the one matching the shot — profile → side, close-up → expression or front, long shot → full body.
- Prompt experiments, off by default and recorded on the take (`studio_experiments`): `frameHolds` (0–0.2 s hold on the first frame, last 0.3 s settle on the end frame), `restateFrame` (keyframe shots restate the first frame's people and props), `positiveCast` ("only the people and objects already in the first frame appear"). Each changes text the turbo LoRAs were trained on; A/B them on one shot before a project default (`look.experiments`).

## Frames

- Frames must match the render: 1344×768 (16:9). `lint_project` flags hero / end frames of another aspect ratio or of different sizes (`frames.aspect`, `frames.size`); uploads and imports record their size.
- First and last frame must agree outside the action: FL2VA interpolates every difference, so a wall that changes colour fades and a cup that grows, grows. The Board's frame check shows the difference.
- A push-in from a hero frame with no end frame drifts; an end frame cropped from the hero frame (`derive_end_frame`, Board button) forces the push.
- The Studio has no image model: frames and sheets come from uploads, from the director's own image tool (`import_image` by URL or base64, `request_upload` + `commit_upload` for files), or from last frames of finished takes.

## Takes

- The first frame of an I2VA / FL2VA take is the input image: on a `continuous` cut it duplicates the anchor's last frame, and it is sharper than the video after it. `auto_timeline` drops the first 2 frames of those takes.
- FL2VA can snap onto the end frame in its last frames; check a take and set `tailTrimS` on `auto_timeline` when it does.
- `check_seams`: a linked shot rendered from one take of its anchor no longer matches once the anchor's pick changes, and a continuous cut jumps when the anchor's tail is trimmed.
- A re-render of an identical input (prompt, workflow, frames) differs only by seed; after a rejected take `generate_take` warns and the spend envelope refuses it.

## Pictures on the pod (GPT Image)

- Off per project until the user switches it on (Settings → Director, web only), with an image limit; a quota error from Codex or the API stops painting until the user resumes it.
- Image jobs run on the GPU pod beside the renders, on their own lane (`workers/h3-runpod/paint.py`). `codex`: one `codex exec` per picture with the image tool, the login on the network volume (device-code login on the Machine page, once), refs passed as paths (at most five pictures), the aspect ratio said in the prompt and checked after (one retry). `api`: an OpenAI-compatible images API (`OPENAI_API_KEY`, `IMAGE_MODEL`, default gpt-image-2), per call.
- Edits with a `region` paste back only that box (soft edge inside it); every pixel outside is the base's. Each edit uploads a preview and a difference image (black = unchanged) for the review.
- `crop` (push-in / pull-out frames) and `extract` (one exact frame of a take, 24 per second) are not painting: no quota.
- Results are assets with what was asked in their meta (purpose, prompt, base, region, frame), attached where asked (sheet view, first / last frame, style frame).

## Viggle Remake (fixing a take)

- Two LoRAs on the H3 base, shipped merged into int8 transformers (21 GB each, downloaded onto the volume from the Machine page): `edit` (objects, props, wardrobe, background, weather, light, style) and `swap` (people). Node pack installed at pod boot.
- Inputs: the take (motion, camera, timing and sound are copied), 1–4 painted frames each pinned to the source frame it was painted from, and MiniMax-H3's six-section prompt, written as a description of the target video; `retention_analysis` is obeyed literally. Pinned frames also fix the composition at that frame.
- Length: 17n+5 frames between 90 and 345 (a 5.17 s take = 124, 10.13 s = 243, a 15.1 s take is cut to 345). Output 1280×736 (short edge 736) or 832×480; the assembler scales it to the export.
- Known failures (Viggle): a non-humanoid character in one long take, small artefacts in fine detail, drift in a multi-shot clip without pins. It does not fix motion, direction or timing.

## What the Studio assembler does today

- Cuts and dissolves between clips, `repeat` for loops, per-clip `speed` (0.5–2; 0.8–1.25 reads as natural) and `muteOwnAudio` (also set by a review with `audioOk: false`), a music asset and three mix sliders.
- Colour: every source is read with its tagged matrix, an untagged one as BT.601 (PyAV's default RGB → YUV; `ASSEMBLER_UNTAGGED_MATRIX=bt709` overrides), converted to BT.709 and tagged. Untagged BT.601 shown as BT.709 shifts reds (measured: 200,49,50 displayed as 213,64,48).
- A cut sheet with each export: 3 frames before and after every cut, one row per cut, for the film review.
- No whole-clip frame interpolation: it smears motion on AI video. `master-upscaled` uses each take's Open-H3-Regenerate file.
- Not yet: J/L cuts, fades, titles, narration, ducking, silences, burned subtitles.

## What the local assembler adds (`assemble_local`)

- Transitions: dissolve, fade to black, fade to white, white flash, iris, wipe (ffmpeg `xfade`).
- Per-clip `speed` and `sourceMatrix` (default `bt601`); output tagged BT.709.
- J-cut (`audioLeadS`) and L-cut (`audioTrailS`) per clip; `freezeS` to hold a last frame; `muteOwnAudio`.
- Title cards (full-frame) and overlays/captions (`drawtext`); OSD for found-footage styles.
- A narration track (files from `synthesize_narration` or the user's recording) and a music file with ducking under narration, fades, and silences (whole bus out).
- Burned subtitles from an SRT (`check_subtitles` writes it) and a loudnorm to −14 LUFS.
- Inputs are the take files: download each selected take's URL (from `get_project` assets or `get_take`) next to the project and set `file` on the clip.

## LoRAs and GPUs

- `list_loras`: the two speed LoRAs (fl2v and ref2v turbo, 8 steps). Put them in the Look; a style preset's `loras` are appended by `compile_look`.
- `gpu_status` before a batch; `gpu_stats` says which GPU type renders a second cheapest. The pod starts itself on the first `generate_take`.

## Budget

- Every tool that spends money answers `needs_confirm` with an estimate first. `plan_batch` sums the batch so one confirmation covers it; keep inside `budgetCapUsd`.
- Previz at the LoRA's step count, one take per shot; `master-upscaled` only at the end.
- `plan_project_batch` gives each shot a fragility score (the `fragile.*` findings), suggests the careful tier (two takes, or the base chain) at 3 or more — unmeasured on H3, so treat it as a hint — and names a probe of the most fragile shots to render first.
- A spend envelope (granted on the web, Settings) lets a reviewed shot render without a confirmation, inside the envelope, with a decision-log entry.
