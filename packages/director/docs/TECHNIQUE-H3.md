# Technique: the self-hosted H3 you are writing for

The implementation half of the guide. Nothing here is a directing rule; it is what the model and the assembler can and cannot do.

## Resolution, frame grid, durations

- 1344×768 at 24 fps is the verified resolution (the turbo LoRAs are 768p models). Other aspect ratios are untested.
- Durations snap to a frame grid: 5 s → 5.2 s, 10 s → 10.13 s, 12 s → 12.25 s, 15 s → 15.1 s (`compile_prompt` reports the exact `effectiveSeconds`). Stay on 5–15 s per shot; chain with `continuous` or `bridge` for longer action.
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

## What the Studio assembler does today

- Cuts and dissolves between clips, `repeat` for loops, a music asset and three mix sliders.
- Not yet: J/L cuts, fades, titles, narration, ducking, silences, burned subtitles.

## What the local assembler adds (`assemble_local`)

- Transitions: dissolve, fade to black, fade to white, white flash, iris, wipe (ffmpeg `xfade`).
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
