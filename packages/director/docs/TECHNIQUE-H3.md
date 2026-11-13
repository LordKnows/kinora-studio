# Technique: the self-hosted H3 you are writing for

The implementation half of the guide. Nothing here is a directing rule; it is what the model and the assembler can and cannot do.

## Resolution, frame grid, durations

- 1344×768 at 24 fps is the verified resolution (the turbo LoRAs are 768p models). Other aspect ratios are untested.
- Durations snap to a frame grid of 17k+5 frames at 24 fps, 124 to 362 frames, nearest: 5 s → 124 frames (5.17 s), 6 → 141 (5.88), 7 → 175 (7.29), 8 → 192 (8.0), 9 → 209 (8.71), 10 → 243 (10.13), 12 → 294 (12.25), 15 → 362 (15.08). `compile_prompt` reports the `effectiveSeconds`. A take can be shorter than the shot asks (6, 9, 11, 13, 14 s), so cut to the take. Stay on 5–15 s per shot; longer action is two shots chained with `continuous` (`split_shot`) or `bridge`.
- Cost is GPU time times the pod's price, and the Studio estimates it as linear in length: an average of GPU-seconds per output second for the GPU type, from finished takes (`gpu_stats`). On the takes so far (8 steps): RTX PRO 6000 about 19 GPU-s per output second for takes under 6 s (n=18) and about 27 for takes of 7.3 to 10.1 s (n=5); RTX 5090 about 30 (n=1) and 49 (n=6). So a longer take costs somewhat more per second, about 1.4 times, on small samples that mix workflows and orientations. A 20-step take (no speed LoRA) costs 2 to 2.5 times an 8-step one. `plan_batch` uses the compiler's estimate when it has one and the per-second average otherwise.
- Length: a shot that carries an action runs 5 s, 8 s at most; a hold 10 s. Long action is two shots joined with `continuous` (12 s is 6 + 6; `split_shot`), by the user's decision for this project. It is a rule of the project and not a measurement: length against quality was never rendered side by side on H3, and identity drift and mistimed actions turned up in 5 s takes too. Do not cite it as a finding about the model.
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
- Dialogue: on-screen lines compile to the H3 guide's `(S1) says: <d>[Chinese] …</d>` with the speaker's voice-card description; off-screen and inner lines stay out of the prompt and are voiced separately. Mandarin accuracy and lip-sync are not yet measured here: keep lines short, one beat each. `experiments.voiceRefs` (R2VA `<Audio j>` voice references) and `experiments.audioFirst` (an I2VA take anchored on a prepared line) are under test.
- On-screen text: never ask the model (H3 draws only text a prompt quotes, so quote none); the assembler adds titles, captions and on-screen displays from the timeline's `titles`.
- No negative prompt: H3's guider runs at cfg 1 with no negative branch, so every word of the Look is drawn. The Look's constraints (`look.negative`) are statements of what the picture shows: "exactly two people in the room", "the street is empty", "sharp focus, crisp detail". A bare negative-prompt word ("blurry", "cartoon") and a ban on text ("no logos", "no subtitles": H3 draws only text a prompt quotes) are left out of the prompt; any other "no X" goes in as written and can add X. `lint_project` and `update_look` name each one with its positive form (`look.constraints.*`). To keep something from a reference, use the shot's references and fixed features, not a ban. The compiler's own speech rule is a statement too: a shot with lines says "The lines above are the only words spoken"; one with only off-screen or inner lines says "Mia stays silent, lips closed"; one with no lines says "Mia stays silent" unless the action or the sound gives the cast a voice (a laugh, a purr), and says nothing when no character is in the shot. The style presets' constraints are written the same way.

## Staging fields and what they compile to

- `blocking` → "Mia enters from frame left, then moves to frame right." lines; `composition` → "the subject's eyes sit on the left third, about 38% from the left edge"; a scene `palette` → "Scene palette #…" in the LOOK; an element's `fixedFeatures` → "Mia always has a dragon tattoo on the left forearm, in every frame", in every mode including keyframe.
- Reference images tagged with a view (`select_element_refs` views): R2VA picks the one matching the shot — profile → side, close-up → the `face` portrait (then expression, front), long shot → full body. `face` is one head-and-shoulders portrait per character, and the root of its sheet: the expressions (four in one picture, the test that the identity holds) and up to three `detail` pictures (fixed features off the face) are drawn from it, then the front figure from the portrait and the details, then side and back from all of those. Every picture copies the portrait itself; the expression grid is never an identity reference. A shot frame gets each character's figure and portrait, figures first, a close-up also the expression grid, and the style frame is dropped first when the model's picture limit is reached. In R2VA only close-ups take it: with one reference per character a wider shot needs the picture that also shows the clothes. Unmeasured on H3: whether a portrait reference pulls the framing toward a close-up; the prompt says it gives the identity only.
- A shot's `state` (how its elements are when it ends, where that differs from their sheets: `wardrobe`, `holding`, `condition`) → for every later shot the element is on, "Mia, from the start of the shot: holding the closed red umbrella; soaked through, hair dripping." and, where the shot changes it, "Mia, by the end of the shot: …"; in a frame's brief, "At this moment, unlike the reference sheets: …". In every mode: a sheet shows the designed look, so a reference-mode shot has only these words to carry it (`state.reference`).
- The prompt's format: the fields are MiniMax's (the H3 prompt guides in MiniMaxAI/MiniMax-H3); lightx2v's notes for its turbo LoRAs use the same fields, and what captions the LoRAs were distilled with is not published. The Studio's default serialisation is the one the handoff graphs rendered with and differs from MiniMax's published format in five places: the instruction line (inside `integrated_multimodal_description`, against the first line of the prompt with a blank line after it); the first-and-last-frame instruction (the first-frame sentence with ", and the target video ends on <Picture 2>", against "How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark …; Picture 2 (from Shot N) aligns with the S.SS-second mark …"); text-to-video (an instruction line, against none); time inside a shot ("0–2.5s: …" per beat, against time only at cuts, "[Shot 2] At 00:03.500, the camera cuts to …", with the beats in order as prose and a line tied to its beat); the camera ("Camera: …" as a label, against "The camera pushes in with small amplitude at slow speed." as a sentence, middle values left out). `experiments.officialFormat` compiles MiniMax's. Which follows a shot better on the 8-step turbo chain is not measured: `plan_ab` test `format`.
- Prompt experiments, off by default and recorded on the take (`studio_experiments`): `officialFormat` (above), `frameHolds` (0–0.2 s hold on the first frame, last 0.3 s settle on the end frame), `restateFrame` (keyframe shots restate the first frame's people and props), `positiveCast` ("only the people and objects already in the first frame appear"). Each changes the compiled text and none is measured; A/B them on one shot before a project default (`look.experiments`).

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
- Measured on every finished take's file, by the worker, with ffmpeg and no model: the change between consecutive small grey frames at 8 a second (0 is a still), the RMS level of the take's sound ten times a second, and the difference between the take's first and last frame and the pictures it was given. The Studio reads them against the shot (`get_take` → `measured`): `motion.early` (three quarters of a beat's movement in its first 30 %), `motion.idle_beat`, `motion.still`, `motion.jump` (an abrupt change away from the shot's own cuts), `motion.no_cut`, `motion.tail`, `motion.head`, `sound.silent`, `sound.line_quiet` (nothing audible in a timed line's window; the level cannot tell speech from other sound), `frame.start`, `frame.end` (the last frame further from its picture than three times what the first frame measures). The thresholds are first guesses, most of them a take compared with itself; every finding is a place to look and suggests a fault tag, none is a verdict.
- A retake carries `studio_retake`: the take it follows, what changed against it (`prompt`, `frames`, `mode`, `steps`, `length`, `loras`, `experiments`, `remake`, or `seed` alone), the faults tagged before it, and the director's `change`. The retro's table "which change got past which fault" is built from these pairs.
- `TakeRequest.turbo: false` renders one take on the base chain whatever the shot's switch says: for the `steps` A/B only.

## Pictures on the pod (GPT Image)

- Off per project until the user switches it on (the project's Settings page, web only), with an image limit; a quota error from Codex or the API stops painting until the user resumes it.
- Image jobs are drawn by painters away from the GPU (`workers/painter`: a small always-on machine, the GPU pod only as a fallback), so every picture is ready before the pod starts. `codex`: one `codex exec` per picture with the image tool, the login in the painter's state dir (device-code login from the Machine page, once), the pictures attached in order (`-i`, at most five), the aspect said as a standard ratio (16:9, 3:4: the tool has no size argument) and redrawn once only when far off; every result carries pixel checks and, with the project's self-check on, a fresh Codex session's rubric (a blocker is redrawn once with its findings). `api`: an OpenAI-compatible images API (`OPENAI_API_KEY`, `IMAGE_MODEL`, default gpt-image-2), exact size, per call. Every picture has a handle (`IMG-12`) and a name. See `docs/picture-quality.md`.
- Edits with a `region` paste back only that box (soft edge inside it); every pixel outside is the base's. Each edit uploads a preview and a difference image (black = unchanged) for the review.
- `crop` (push-in / pull-out frames) and `extract` (one exact frame of a take, 24 per second) are not painting: no quota.
- Results are assets with what was asked in their meta (purpose, prompt, base, region, frame), attached where asked (sheet view, first / last frame, style frame).

## Viggle Remake (fixing a take)

- Two LoRAs on the H3 base, shipped merged into int8 transformers (21 GB each, downloaded onto the volume from the Machine page): `edit` (objects, props, wardrobe, background, weather, light, style) and `swap` (people). Node pack installed at pod boot.
- Inputs: the take (motion, camera, timing and sound are copied), 1–4 painted frames each pinned to the source frame it was painted from, and MiniMax-H3's six-section prompt, written as a description of the target video; `retention_analysis` is obeyed literally. Pinned frames also fix the composition at that frame.
- Length: 17n+5 frames between 90 and 345 (a 5.17 s take = 124, 10.13 s = 243, a 15.1 s take is cut to 345). Output 1280×736 (short edge 736) or 832×480; the assembler scales it to the export.
- Known failures (Viggle): a non-humanoid character in one long take, small artefacts in fine detail, drift in a multi-shot clip without pins. It does not fix motion, direction or timing.

## What the Studio assembler does

Everything below is on the timeline `save_timeline` takes; `export_project` renders it.

- Joins: a cut, or a transition the assembler draws on the clip that comes in: `dissolve`, `fade_black`, `fade_white` (a flash at 0.2 s), `iris`, `wipe`, each 0.2–1 s. `repeat` for loops, per-clip `speed` (0.5–2; 0.8–1.25 reads as natural), `freezeS` to hold a last frame in silence, `muteOwnAudio` (also set by a review with `audioOk: false`).
- J-cut and L-cut: `audioLeadS` / `audioTrailS`, up to 2 s. The sound is the take's own before `inS` and after `outS`, so a clip that starts on its take's first frame has nothing to lead with; the export says how much the take really had.
- Titles: `card` (covers the picture: an intertitle, a main title), `overlay` (on the picture), `caption` (small, at the bottom), each with a time, a length, an optional position, colour, background and size. Drawn with a CJK font; lines are centred one by one.
- Sound: narration lines (audio assets at their times), a music asset looped under the cut and ducked under clips and narration, three mix sliders, `silences` (the whole mix out), `fadeInS` / `fadeOutS` (picture and sound), and a two-pass loudness target, −14 LUFS by default (`loudnessLufs: null` leaves the mix alone; a silent film is left alone too).
- Subtitles: an SRT, burned in on request. On-screen lines are captioned inside their shot: at their own `startS` / `endS` when the line has them (shifted by the clip's trim and speed), otherwise spread evenly. Narration lines made with `speak` keep their text, and each gets a cue as long as its audio measures. A line that is both in a shot's dialogue (off-screen, inner) and on the narration track is captioned once. The cues as written are checked for reading time (`get_export` findings). Not yet: timing an on-screen line from the take's own sound; the speech recognition the Studio calls returns text without timestamps.
- Sound design: a shot with no ambience of its own compiles with its scene's row of the sound design table.
- Colour: every source is read with its tagged matrix, an untagged one as BT.601 (PyAV's default RGB → YUV; `ASSEMBLER_UNTAGGED_MATRIX=bt709` overrides), converted to BT.709 and tagged. Untagged BT.601 shown as BT.709 shifts reds (measured: 200,49,50 displayed as 213,64,48).
- Checks on the finished file: integrated loudness and true peak, black picture, silent stretches. The Studio reads them against the timeline and `get_export` lists the findings: black that no fade, card or through-black transition explains, missing sound that is not a silence, a missed loudness target, a J/L cut the take could not give. A card with little text measures as black; that is expected and explained.
- A cut sheet with each export: 3 frames before and after every cut, one row per cut, for the film review.
- No whole-clip frame interpolation: it smears motion on AI video. `master-upscaled` uses each take's Open-H3-Regenerate file.
- Not yet: separate dialogue and effects stems (`mix.sfxDb` is accepted and unused), a title's free position or font.

## The local assembler (`assemble_local`)

The director package renders the same timeline with ffmpeg from take files on disk: for work away from the Studio, or to try a cut before spending an export. It also takes a clip's own gain, a title's free x/y and font, and narration from a file. Inputs are the take files: download each selected take's URL (`resultUrl` in `get_project` / `list_takes`, or `get_take`) next to the project and set `file` on the clip.

## LoRAs and GPUs

- LoRAs are per shot, never in the Look and never the user's to pick. Each shot has two switches, both on by default and turned by the user on the Board: **use turbo** loads the speed LoRA for the shot's workflow (fl2v or ref2v turbo, 8 steps on its chain; off = the base chain at 20 steps, about 2.5× the time) and **use LoRA** loads the style / effect LoRAs the director assigned.
- Once the board is designed: `list_loras` with `projectId` (per shot: workflows, size, vfx, animation, what could load, the style's suggestions), then `assign_loras`, each LoRA with a one-line `why` the user reads on the shot, `[]` where none suits, at most 3 per shot, never a speed LoRA. A style's `loraSuggestions` name the shots they are for: assign them to those only. `lint_project`: `lora.unassigned` asks for the pass, `lora.workflow` flags an assignment the shot can no longer load.
- `gpu_status` before a batch; `gpu_stats` says which GPU type renders a second cheapest. The pod starts itself on the first `generate_take`.

## Budget

- Every tool that spends money answers `needs_confirm` with an estimate first. `plan_batch` sums the batch so one confirmation covers it; keep inside `budgetCapUsd`.
- Previz at the LoRA's step count, one take per shot; `master-upscaled` only at the end.
- `plan_project_batch` gives each shot a fragility score (the `fragile.*` findings), suggests the careful tier (two takes, or the base chain) at 3 or more — unmeasured on H3, so treat it as a hint — and names a probe of the most fragile shots to render first.
- A spend envelope (granted on the web, on the project's Settings page) lets a reviewed shot render without a confirmation, inside the envelope, with a decision-log entry.
