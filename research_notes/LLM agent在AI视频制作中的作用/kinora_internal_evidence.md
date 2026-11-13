# Kinora Studio (影匣) internal evidence: where an LLM director agent's work matters

Scope and method. Sources are the repository at `/home/user/open-higgsfield-server` (files cited as `path:line`), its git history (commit hashes), and read-only calls to the `studio` MCP server (cited as `tool(args)` plus record id). The `studio` MCP server was reachable; the separate `director` MCP server failed to connect ("Connection closed"), so the director package was read from source only. No generating, rendering, saving or editing tool was called. Three evidence grades are used throughout: **[measured]** (a number or observation from takes/records), **[default]** (a rule the project says it chose without measurement), **[asserted]** (stated in a guide with no data behind it in this repo).

Caveats that apply to everything below:
- The git clone is shallow: 89 commits (67 non-merge), 2026-11-09 to 2026-11-13, the earliest visible being the merge of PR #27 (`git log`, `git rev-parse --is-shallow-repository` = true). PRs #1–26 are not visible.
- Production records are small: 12 projects, 6 with any spend; 83 takes in total across their retros, of which only 11 carry a take review, and only 2 projects have fault tags (see section 5).
- Two of the projects with spend are adult-content projects (`prj_u21g51xfupdx`, `prj_z56v3lc7o3nb`, `prj_plv4q89rgvnp`); they are cited by id and by their counts only.

---

## 1. What the project states about H3's prompt behaviour

### Takeaway
The self-hosted H3 takes exactly one text input, has no negative prompt and no CFG, renders one generation per shot on a fixed frame grid (17k+5 frames, 124–362, 24 fps), and draws only text a prompt quotes. Every one of these facts is listed in `AGENTS.md` under "Facts that were got wrong once", i.e. each was at some point encoded wrongly in the guides or the compiler.

### Cited Findings
- **Single text input.** The prompt field of node 104 is "唯一的文本输入" (the only text input) — `docs/handoff/HANDOFF.md:26`. [measured: taken from the workflows that actually ran, `HANDOFF.md:3`]
- **No negative prompt, no CFG.** "负向提示词 | 无 | — | H3 节点没有负向输入，引导器是 `BasicGuider`（不做 CFG）" — `docs/handoff/HANDOFF.md:27`; "CFG | 不适用（BasicGuider，等效 1）" — `HANDOFF.md:81`. Restated: "No negative prompt: H3's guider runs at cfg 1 with no negative branch, so every word of the Look is drawn." — `packages/director/docs/TECHNIQUE-H3.md:43`; "H3 has no negative prompt. A Look's constraint ... is a statement of what the picture shows; a ban is drawn as the thing it bans (`lintConstraints`)." — `AGENTS.md:43`. The compiler sends `negative: ""` — `src/studio/compiler.ts:265-266`.
- **Frame grid.** "单位是帧，不是秒。24 fps，帧数按 17k+5 取整：124 帧 ≈ 5.17 s，243 帧 ≈ 10.1 s。节点说明的训练范围约 124–362 帧" — `HANDOFF.md:28`. "Durations snap to a frame grid of 17k+5 frames at 24 fps, 124 to 362 frames, nearest: 5 s → 124 frames (5.17 s), 6 → 141 (5.88), 7 → 175 (7.29), 8 → 192 (8.0), 9 → 209 (8.71), 10 → 243 (10.13), 12 → 294 (12.25), 15 → 362 (15.08) ... A take can be shorter than the shot asks (6, 9, 11, 13, 14 s), so cut to the take." — `TECHNIQUE-H3.md:8`; same in `agent/director.md:92` and `AGENTS.md:38`. Lint enforces 5–15 s per shot as an error (`duration.range`) — `packages/director/src/lint/shotlist.ts:39`.
- **One shot = one generation; beats are time-stamped lines inside one prompt.** "One shot is one generation. Beats are time-stamped sub-descriptions inside that single prompt (`0–6s: … 6–12s: …`); a beat with `cut: true` asks the model for a hard cut inside the same clip (at most 3). Separate generations come only from separate shots and their links." — `TECHNIQUE-H3.md:11`; `AGENTS.md:37`.
- **Text rendering.** "H3 draws only the text a prompt quotes, and the Studio quotes none. Titles, captions, signs and on-screen displays are added by the assembler, so they are exact. For the same reason a ban on text in the Look adds nothing but the word." — `AGENTS.md:42`; `TECHNIQUE-H3.md:42`; `agent/editing.md` ("Only in the timeline", Titles bullet).
- **Prompt format is fixed by the turbo LoRAs' training captions.** "prompt 用 lightx2v 的结构化格式，turbo LoRA 是用这种格式训练的": `integrated_multimodal_description / overall_soundscape / non_diegetic_music` with `<Picture 1>`/`<Picture 2>` for I2VA/FL2VA/T2VA; `subject_definitions / summary / retention_analysis / detailed_description / overall_soundscape / non_diegetic_music` with `<Subject N>` for R2VA — `HANDOFF.md:48-50`; mirrored in `src/studio/compiler.ts:98-102, 722-785`.
- **Modes.** `text` (T2VA), `keyframe` (I2VA; FL2VA with an end frame), `reference` (R2VA: sheets as `<Subject N>`, two slots by default, up to nine); mutually exclusive per shot; no edit mode — `TECHNIQUE-H3.md:16`; `agent/director.md:93`. Two base models (fl2va for T2VA/I2VA/FL2VA, ref2va for R2VA), ~2 min reload on a switch — `HANDOFF.md:62`, `TECHNIQUE-H3.md:17`.
- **Reference-to-video vs image-to-video.** R2VA "reads references, not a first frame" — `agent/director.md:49`. Linked shots (`continuous`, `insert_return`, `reverse`, `bridge`, `jump_cut`) take the anchor take's last frame as their first frame and "cost no reference slots" — `agent/director.md:18, 50-52`; `agent/editing.md` table. "`match_cut` feeds the anchor's last frame as a reference image; the model keeps subjects more reliably than composition. Prefer `continuous` / `bridge` when the join must be exact." — `agent/director.md:97`. Compiler: a first-frame link overrides `reference` mode ("H3 cannot combine them") — `src/studio/compiler.ts:170`. At most 3 reference images per R2VA take — `compiler.ts:109, 413-447`.
- **FL2VA interpolates every difference between first and last frame**: "a wall that changes colour fades and a cup that grows, grows" — `TECHNIQUE-H3.md:54`. FL2VA end frame was verified to be reproduced nearly exactly — `HANDOFF.md:14`. [measured on one handoff run]
- **Resolution.** 1344×768 at 24 fps is "the verified resolution (the turbo LoRAs are 768p models). Other aspect ratios are untested." — `TECHNIQUE-H3.md:7`.
- **The agent cannot see motion or hear sound.** "You see stills, not motion, and you hear nothing ... Never tell the user a take moves well or sounds right." — `agent/director.md:29`.

### Inferences
- Because there is one text channel, no negative branch and no guidance scale, the only prompt-side levers are *which statements are in the single prompt* and *which images accompany it*. Everything a conventional diffusion "negative prompt" would do has to be done upstream: by the story (leave the fragile thing out), by a frame (show the right thing), or downstream by the assembler (text, transitions, music).
- The official guides repeat the same H3 facts in two places (`agent/director.md` and `packages/director/docs/`), and `AGENTS.md:41` records that keeping them in sync was itself a failure point.

### Gaps
- `TECHNIQUE-H3.md:7` says other aspect ratios are untested, yet the records show 9:16 takes at 768×1344 (`get_shotlist(prj_pxz50vl9ahuw)`, all takes `videoSize: "768x1344"`; retro of `prj_dv8phoozmfds`: "Works: 768x1344 renders coherently"). No systematic comparison of orientations exists in the repo.
- `TECHNIQUE-H3.md:56` ("The Studio has no image model") is stale against `agent/director.md:36` (three image models). `agent/director.md:122` still says "Previz at 8 steps". The guides are not fully consistent.
- `packages/director/src/lint/craft.ts:33` says "the model cannot spell" while `AGENTS.md:42` says H3 draws text a prompt quotes; the lint message was not updated.

---

## 2. Which stages carry structure and checks

### Takeaway
Every stage from brief to export is a structured record with a gate or a lint, and the project's stated principle is to catch errors at the cheapest stage: "Changing a word costs nothing, a still costs little, a take costs real money." Two human approvals (script, shotlist) and a per-shot review gate sit in front of any GPU spend; take selection is human-only.

### Cited Findings
- Pipeline as the MCP server states it: "script → elements → shotlist → hero frames → takes → timeline → export" — `studio` MCP server instructions; `agent/director.md:76-85` (workflow steps 1–8).
- Principle: "A mistake that can be caught in text never reaches a frame; one that can be caught in a frame never reaches a take." — `agent/director.md:25`.
- **Brief/requirements**: `add_requirements` in the user's words, carried into every review — `agent/director.md:27`; `requirements.open` lint — `src/studio/orchestrator.ts:1104`.
- **Script + treatment**: treatment is a validated structure (three candidate structures, logline/arc, hook ≤ 3 s, 3–6 sequences with seconds and pace, sound row per sequence, ≥ 2 silences and ≥ 2 audio bridges over 30 s, turns as problem → solution → reaction + why) — `packages/director/docs/DIRECTOR.md:40-55`; 16 `treatment.*` codes in `packages/director/src/treatment.ts:74-103`; `treatment.missing/stale` in `src/studio/treatment.ts:55-63`. Story review by a fresh reader — `src/studio/craft.ts:120-140`. Human approval of the script on the Story page — `agent/director.md:127`.
- **Elements**: characters built face-first (portrait → expressions/details → front → side/back), each stage reviewed before the next; `fixedFeatures` compile into every prompt — `agent/director.md:63-70, 79`; `compiler.ts:618-621`.
- **Shotlist**: Tier 2 (`link`) + Tier 3 (`cinematography`) + `blocking`, `motion`, `composition`, `frames.first/last`, `scriptLines`, scene `palette` and `sound` row — `agent/director.md:80`; linted by `lintShotlist` + `lintCraft` (section 4). Human approval on the Board; "Nothing can render before both approvals" — `agent/director.md:80`. Delegated approval exists but only the user can switch it on — `agent/director.md:129-135`.
- **Hero frames**: `plan_frames` table (reuse > crop > edit > draw new) — `agent/director.md:44-61`; painter pixel checks + auto-review + fresh frame review — `agent/director.md:40`, `docs/picture-quality.md:50-52`; `frames.aspect/size/pushin` lint — `orchestrator.ts:1155-1162`.
- **Per-shot prompt compilation**: deterministic compiler, "无 LLM" — `docs/cinema-studio-h3-design.md:359`; `src/studio/compiler.ts:11-14`. Compile-time warnings (dialogue timing, dropped references, dropped constraints, LoRA fit, prompt > 7000 chars, frame-grid mismatch) — `compiler.ts:169-170, 227-238, 270, 344-356, 422`.
- **Takes**: `generate_take` refuses until the exact prompt and frames passed a shot review; a revision makes the review stale; re-rendering an identical rejected input is warned/refused; stop after 3 attempts — `agent/director.md:82`; the gate was made real in commit `cd0e3b4` ("a missing shot review was a warning that confirm: true passed"). Fault tags on takes (20 tags) feed the retro — `src/studio/schemas.ts:421-425`.
- **Timeline / sound / export**: `auto_timeline` + `check_seams` (`seam.anchor`, `seam.trim`) — `orchestrator.ts:788-792`; `check_timeline` (18 codes) — `packages/director/src/timeline/extended.ts:92-159`; `check_cue_map` (8 codes) — `packages/director/src/sound/cuemap.ts:93-110`; sound plan held against the timeline (`sound.table`, `sound.plan`) — `orchestrator.ts:1099-1100`; export file measured (loudness, true peak, black picture, silent stretches) and compared to the timeline — `TECHNIQUE-H3.md:91`; film review with a cut sheet — `src/studio/craft.ts:235-253`.
- **Retro and decision log**: `get_retro` counts faults by tag, takes and prompt revisions per shot, review coverage, and lists "what got past a fault" — commit `cd0e3b4`; `log_decision`/`list_decisions` — `agent/director.md:30`.
- What the project says the film is judged on: "sound, rhythm, camera, directing (performance, staging, emotional arc). Good-looking takes are only the starting point." — `DIRECTOR.md:5`. "The storyboard decides the film more than the plot does." — `DIRECTOR.md:63`. [asserted]
- "A plan that is only prose is not held to ... A new planning rule goes into one of those [treatment, sound rows, timeline], not only into a guide." — `AGENTS.md:44`; made true by commit `7a6c494` ("Four things the guides asked for and nothing enforced").

### Inferences
- The structure is front-loaded: the stages before any GPU spend (requirements, treatment, script, elements, shotlist, frames, shot review) carry far more records and gates than the take stage itself, where the only automatic rules are "reviewed first", "not the same input twice" and "stop after three".
- The system's design assumption is that the LLM agent's leverage is in *what it decides to shoot and how it allocates it*, with formatting removed from its hands (`agent/director.md:3`: "Your job is judgement, not formatting").

### Gaps
- No record shows the full pipeline run end-to-end with all gates: every retro reports "Film reviews: 0", and fresh-reviewer shot reviews are 0 in every project (section 5). The gates exist in code; their effect on outcomes is not demonstrated in the records.

---

## 3. How a shot's prompt is built, and how much of it the agent authors

### Takeaway
The agent never writes the H3 prompt (unless it uses `promptOverride`); it fills structured fields and a deterministic compiler serialises them into the LoRA-trained caption format. In one real compiled prompt, about one third of the characters were per-shot agent free text, about another third was project-level free text (Look, palette, element features) written once, and about one third was template and catalogue phrases.

### Cited Findings
- "The Studio writes the prompt in the format the turbo LoRAs were trained on; you fill structured fields, never the prompt itself (unless `promptOverride`)." — `agent/director.md:94`. `promptOverride` bypasses `buildPrompt` entirely — `src/studio/compiler.ts:233`. Design rationale: "确定性 Compiler 而不是让 agent 直接写 prompt | 稳定、可审计、Look 永不遗漏；代价是表达力受 schema 限制，所以保留 `promptOverride`" — `docs/cinema-studio-h3-design.md:1053`.
- **What is fixed by template** (`compiler.ts`): field names and header (`:774-781`); "One single continuous take with no cuts that starts exactly on <Picture 1> and ends exactly on <Picture 2>." (`:747`); "The shot ends on the final frame provided." (`:631`); link sentences per link type, e.g. `continuous` → "Continue the previous shot's action and camera from the first frame without a cut." (`:522-530`); R2VA `subject_definitions`/`retention_analysis` lines ("fully_preserved - … are retained") (`:752-772`); speech rule ("The lines above are the only words spoken" / "X stays silent, lips closed" / "X stays silent") (`:701-703`); dialogue format `(S1) says: <d>[Chinese] …</d>` (`:667`).
- **What comes from enumerated keys → catalogue prose**: camera move (13 moves, fixed phrases, plus amplitude/speed) (`compiler.ts:124-138, 638-642`); cinematography keys size/angle/lens/dof/lighting/grade/texture/vfx/animation/pace rendered by `renderCinematography` (`:559, 644-648`; "Cinematography keys ... compile to prose" — `TECHNIQUE-H3.md:39`); composition `subjectX` → "about 38% from the left edge" (`:520`); blocking positions → "enters from frame left, then moves to frame right" (`:510-518`).
- **What comes from the project Look (written once)**: genre, palette, camera+lens, lighting, scene palette, LoRA trigger words, on every shot (`compiler.ts:589-595`); Look constraints after filtering (`:707`, `packages/director/src/lint/constraints.ts:68-90`). "the project Look is injected into every shot's prompt, so the style's Look fields carry most of the style" — `TECHNIQUE-H3.md:39`. A style preset can supply the Look, cinematography defaults, allowed camera moves, a duration guide and a per-beat suffix (`src/mcp/server.ts:154`; `TECHNIQUE-H3.md:40`).
- **What comes from elements**: in `text` mode, full element descriptions; in `reference` mode only "X looks exactly as in the reference image."; in `keyframe` mode nothing about who/where except `fixedFeatures` ("X always has …, in every frame") — `compiler.ts:603-621`. Which reference picture R2VA gets is chosen by the compiler from shot size/angle (`preferredViews`, `:455-465`), in a fixed priority hero frame → characters → location → props, max 3 (`:413-447`).
- **What is the agent's free text per shot**: `intent`, `beats[].action` (with their time windows), `blocking[].note`, `camera.note`, `composition.note`, `dialogue[].text/delivery`, `sound.sfx/ambience/music` — `compiler.ts:623, 627, 641, 646, 667, 683-687`. Also `frames.first/last` descriptions, which go to the image model, not to H3 (only into the H3 prompt under the `restateFrame` experiment, `:610-613`).
- **What the frames/links fix without words**: workflow and images are decided by link type and mode, not by the prompt (`compiler.ts:163-214`); "Nothing here needs the model to 'remember' earlier shots: the frame does the remembering." — `agent/editing.md:3`. "Do not describe what a hero frame already shows (faces, wardrobe, set). Describe what happens." — `agent/director.md:108`.
- **Measured share on one real take** — `get_take(tke_neupodk9lgw1)`, project `prj_pxz50vl9ahuw`, shot 3, FL2VA, 6 s. Segmenting the compiled prompt by source (my character count over ≈4,100 chars): template text and field names 16.8 %; catalogue phrases from enum keys 14.3 %; project Look + scene palette + Look constraints 19.0 %; element `fixedFeatures` 17.3 %; per-shot agent free text (intent, two beats, blocking notes, camera note, composition note, sound) 32.7 %. [measured, n=1, hand-segmented]
- The same take's prompt shows compiler-side wording faults that were later fixed: it ends "no on-screen text. no logos. no subtitles. no photorealism. no extra people. No dialogue." (bans drawn into a model with no negative prompt; fixed by `26bd57e`, `caeb197`), and fixed features read "…visible on the both eyes", "…on the whenever she smiles", "on the her own left wrist" (the "on the on his face" bug fixed in `cd0e3b4`) — `get_take(tke_neupodk9lgw1).prompt`.
- Prompt A/B switches exist but are off by default: `frameHolds`, `restateFrame`, `positiveCast`, `voiceRefs`, `audioFirst` — `TECHNIQUE-H3.md:49`, `compiler.ts:610-613, 630-631, 691-692`.

### Inferences
- In keyframe/FL2VA mode the agent's per-shot wording controls essentially three things: what happens in which time window (beats), who moves where (blocking notes), and sound. Identity, wardrobe, set, light and camera position are carried by the first/last frame and the Look; framing vocabulary is catalogue prose selected by a key. So the agent's largest per-shot decisions are structural (duration, beat boundaries, mode, link, which frames exist, which references fill the three slots), not lexical.
- Since the Look and element features are also free text authored by the agent (when no style preset is used — every retro here reads "Style: —" except one), about two thirds of that prompt was agent-authored *somewhere*, but only one third was authored *for that shot*. Wording decisions made once at project level are replicated into every shot, which is why two of the visible prompt fixes (`26bd57e`, `caeb197`) were to Look-level text, not beat text.
- In that take the catalogue phrase for `lighting: golden` compiled to "warm golden-hour sunlight, long shadows" inside a prompt whose Look says the room is a black dressing room lit by vanity bulbs: enum keys can contradict the agent's own Look. The decision log of `prj_dv8phoozmfds` records the same class of problem as a suspected cause of a failed take ("The 'rain' vfx compiles to 'heavy rain on the lens' and likely caused the glowing blue rain column", `get_retro(prj_dv8phoozmfds)`, decision 2026-11-06T16:14).

### Gaps
- The share figure is one take in one mode. For R2VA and T2VA the split differs (text mode carries full element descriptions; R2VA adds template `subject_definitions`/`retention_analysis`). I did not sample those.
- No record shows how often `promptOverride` was used.
- The design doc's planned prompt evaluation ("P0 prompt 评测方案 … 每条 prompt 规则都有实测依据", `docs/cinema-studio-h3-design.md:449, 1037`) is marked not done: "评测本身待 P0" (`:1154`), "成本常量和 prompt 规则仍是占位" (`:1163`). So the template's wording choices are not backed by an A/B in this repo.

---

## 4. What the lints and reviews check, by class

### Takeaway
Counting distinct finding codes, the automatic checks are overwhelmingly planning-level (roughly 68 codes: tiling, durations, links, variety, coverage, treatment, fragile story content) and edit/sound-level (roughly 31), with only about 6 codes about prompt wording and about 5 about pictures; picture-level checking is done mostly by LLM/vision reviews rather than lint.

### Cited Findings
Classification is mine; code lists are from the source.

**Planning-level (story, coverage, shot allocation, durations, continuity) — ≈ 68 codes**
- `lintShotlist`, 26 codes — `packages/director/src/lint/shotlist.ts:28-107`: `empty`, `duration.tile`, `duration.range` (error), `beats.tile` (error), `beats.gap` (error), `beats.cuts` (error), `link.missing`, `cinematography.missing`, `dialogue.dense`, `dialogue.lines`, `link.anchor` (error), `link.mode`, `montage.long`, `pace.still`, `duration.complex`, `duration.15`, `rhythm.pace`, `rhythm.sizes`, `rhythm.moves`, `rhythm.static`, `rhythm.breath`, `rhythm.durations`, `rhythm.linkrun`, `structure.sequences`, `identity.open`, `render.switches`.
- `lintCraft` staging and fragility, ≈ 20 codes — `packages/director/src/lint/craft.ts:105-179`: `motion.missing`, `motion.dead`, `motion.contradiction`, `blocking.missing`, `performance.simultaneous`, `props.unlisted`, `blocking.axis`, `blocking.exit`, `rhythm.eyelevel`, `rhythm.sizerun`, and `fragile.*` × 10 (crossing, small_object, text, mirror, light_change, chain, crowd, topdown, asymmetric, dialogue; `craft.ts:31-37, 75-85`). The guide's instruction for `fragile.*`: "fix them in the story, not after the take" — `agent/director.md:110`.
- Treatment, 18 codes — `packages/director/src/treatment.ts:74-103` (`treatment.schema`, `.chosen`, `.duplicate`, `.hook`, `.sequences`, `.pace`, `.breath`, `.silence`, `.bridges`, `.sound`, `.nativeMove`, `.generic`, `.turns`, `.why`, `.reaction`, `.structure`, `.fragile.*`) and `src/studio/treatment.ts:55-63` (`treatment.missing`, `treatment.stale`).
- Script coverage and requirements, 4 codes — `src/studio/orchestrator.ts:1055-1062, 1104`: `script.lines.missing`, `script.quote.stale`, `script.uncovered`, `requirements.open`.
- Story review (LLM cold reader), 7 questions — `src/studio/craft.ts:120-140`: retell in three sentences; ask each turn as reality would; one-sentence premise; hook in 3 s; staggered reactions; "Which moments will an AI video model get wrong?"; script vs treatment.

**Prompt-level (wording) — ≈ 6 lint codes + compile warnings + 5 review questions**
- `wording.direction`, `wording.negation`, `fragile.cartoon` — `craft.ts:38, 117, 120`.
- `look.constraints.bare`, `.text`, `.ban` — `packages/director/src/lint/constraints.ts:100-104` (same lint on a user style's `engine.negative`, commit `716f12d`).
- Compile warnings (not lint codes): dropped constraints, dialogue outside its window or across a hard cut, lines that do not fit the shot, dropped reference images, prompt over 7000 chars — `src/studio/compiler.ts:236-238, 344-356, 422`.
- Shot review part B "The prompt against the frames", 5 questions — `src/studio/craft.ts:198-203` (range within `:184-210`): every sentence matches the images; same camera in both frames; consistent with sheets/palette/neighbours; every movement physically caused, where are the hands; where could the model go wrong.

**Picture-level (frames) — ≈ 5 lint codes + 8 + 9 + 9 review items + 5 pixel checks**
- `frames.missing` — `craft.ts:139`; `frames.aspect`, `frames.size`, `frames.pushin` — `orchestrator.ts:1155-1162`; `palette.contrast` — `orchestrator.ts:1093`.
- Shot review part A "The frames", 8 checks — `src/studio/craft.ts:188-196`: everything the action uses is in the first frame; reactions staged in the first frame; no shared pose; room for the action; wind and cloth agree; readable at phone size; stray things; first/last frame identical where nothing should change.
- Frame review, 9 codes (anatomy, count/extra, identity/wardrobe, feature_side, text, framing/aspect, style/background, edit_scope, prompt_mismatch) — `src/studio/craft.ts:88-96`.
- Painter: 5 pixel checks (blank, borders, crop amount, sheet backdrop, edit scope) and a 9-rule auto-review by a fresh Codex session — `docs/picture-quality.md:50-51`.

**Edit/sound-level — ≈ 31 codes + export measurements + film review**
- `check_seams`: `seam.anchor`, `seam.trim` — `orchestrator.ts:788-792`.
- `check_timeline`, 18 codes — `packages/director/src/timeline/extended.ts:92-159` (`clip.range`, `clip.long`, `clip.speed`, `clip.speed.visible`, `clip.jl*` × 4, `clip.freeze.loop`, `clip.dissolve.first`, `title.outside`, `title.short`, `timeline.jl`, `timeline.silence`, `studio.gain`, `studio.title.place`, `studio.narration`, `studio.subtitles`).
- `check_cue_map`, 8 codes — `packages/director/src/sound/cuemap.ts:93-110`.
- `sound.table`, `sound.plan` — `orchestrator.ts:1099-1100`; `duration.handles` — `craft.ts:144`.
- Export measurements (loudness, true peak, black picture, silent stretches, subtitle reading time) — `TECHNIQUE-H3.md:88, 91`. Film review, 6 items — `src/studio/craft.ts:236-244`.

**Render configuration** — `lora.missing`, `lora.workflow`, `lora.unassigned` (`orchestrator.ts:1126-1137`); `not_reviewed` gate (`orchestrator.ts:1235`).

- Only six lint codes are errors that block approval, all planning/structure: `empty`, `duration.range`, `beats.tile`, `beats.gap`, `beats.cuts`, `link.anchor` — `shotlist.ts:28-63`. `approve_shotlist` requires "no lint errors" — `agent/director.md:132`.

### Inferences
- The lint budget follows what can be checked on structured text: allocation of time, links, variety, coverage. Prompt wording gets only regex-level checks (negation, loose direction, bare negative words), consistent with the agent not writing the prompt.
- Picture-level faults cannot be linted from the shot spec, so the system delegates them to vision reviews (9 + 8 + 9 checklist items) and pixel checks; this is where the largest number of *review* items sits.
- The `fragile.*` family is implemented as a regex over wording but is classified by the guides as a story-stage problem; the remedy offered is to change what is shot, not how it is phrased.

### Gaps
- Counts are by distinct code as read from source; some codes are emitted in several places and some checks (export findings, compile warnings) have no code. Treat the totals as approximate.
- No data on how often each code fires or whether fixing a lint finding lowers the retake rate. `plan_project_batch`'s fragility score is explicitly "unmeasured on H3, so treat it as a hint" — `TECHNIQUE-H3.md:110`.

---

## 5. Recorded failures: what failed, at which stage, and what the fix was

### Takeaway
In the two projects with tagged takes, the 20 fault tags are led by `action_wrong` (4) and `identity_drift` (4); of the eight fault-to-fix chains the retros record, none was fixed by a prompt rewrite alone on an identity fault, and the fixes that held were a changed frame, a changed mode (R2VA → first frame), a re-timed/re-split shot, or a Viggle Remake. The one fresh-reader story review on record failed the first script with four blockers, all planning-level, before any GPU spend.

### Cited Findings

**"Facts that were got wrong once" (`AGENTS.md:37-44`) classified**
- Planning/allocation: one shot = one generation (`:37`); frame grid (`:38`); cost linear, "does not quadruple" (`:39`); length vs quality unmeasured (`:40`); a prose-only plan is not held to (`:44`).
- Prompt wording: no negative prompt (`:43`); text bans add only the word (`:42`).
- Edit: text comes from the assembler (`:42`).
- Process: two guides must be changed together (`:41`).

**Production records, review coverage** (`get_retro` on each project)
- `prj_pxz50vl9ahuw` (Backstage Together, 4 shots, 14 takes, 1.16 USD on takes): "7 of 14 finished take(s) have no review at all"; "Shot reviews: 0 of 4"; story reviews 6 (1 independent); film reviews 0; frame reviews 53 (0 independent); "Pictures drawn: 84 for 4 shot(s), 50 of them edits; the self-check failed 29 of 76".
- `prj_dv8phoozmfds` (The Tilted Umbrella, 2 shots, 6 takes, 1.22 USD on takes): 3 of 6 takes unreviewed; 1 shot review (self); 41 pictures, 27 edits.
- `prj_15gzk9jptltr` (City Cat Stroll, 10 shots, 27 takes, 2.00 USD): 22 of 23 unreviewed; no story, shot, film or frame review; no fault tags.
- `prj_txan6pgtchiv` (369, 2 shots, 4 takes, 0.58 USD): 4 of 4 unreviewed; self-check failed 11 of 29 pictures.
- `prj_u21g51xfupdx` (17 shots, 31 takes, 3.02 USD): 31 of 31 unreviewed; no reviews of any stage; no requirements.
- `prj_fet4g0d3ahop` (Passing By, 7 shots, 1 take): unreviewed; self-check failed 11 of 26 pictures.

**Fault tags** (only two projects have any)
- `prj_pxz50vl9ahuw`: identity_drift 3, action_timing 2, simultaneous_motion 1, action_wrong 1, camera_wrong 1.
- `prj_dv8phoozmfds`: action_wrong 3, colour_drift 2, wardrobe_or_prop_lost 2, text_artifact 1, identity_drift 1, count_changed 1, object_appears 1, face_or_hand_artifact 1.

**Fault → fix chains** (`get_retro` "Carry forward"; details from `get_shotlist(prj_pxz50vl9ahuw)` take reviews)
1. Backstage #2 take 1 (`tke_ywasldg5rgll`), action_wrong + camera_wrong. Cause recorded: "In the first frame her right hand is hidden on the seat edge behind her thigh; the prompt never said so, so the wave appears at chest height with no path ... Prompt asked for a push-in though both keyframes share one camera: now static." Fix: prompt and frames changed. Stage: prompt/spec contradicting the frames (the class shot-review part B checks; no shot review was run).
2. Backstage #2 take 2 (`tke_gss6kq4zvobz`), action_timing + simultaneous_motion. Cause: "Lin Xia lunges up and forward in under a second, because the end frame has her higher and closer than the first frame". Fix: "Shot revised to 7s: 0-2s slow head lift, 2-4.5s hand rises and waves, 4.5-6s slow rise and catch, 6-7s hold." Stage: beat/time allocation (re-plan of the shot's duration and beats) with a frame-pair cause. Take 3 held.
3. Backstage #3 take 2 (`tke_yk5zz2yp4ls8`), identity_drift (heads shrink). Cause measured by the agent on stills: the drawn end frame had "Lin Xia's face ~6% and hair ~12% smaller" than the first frame scaled by the push-in. Fix: a new end frame. Stage: picture.
4. Backstage #3 take 3 (`tke_dayw2p3imx1g`), identity_drift (narrow eyes drawn as large round eyes during the push-in). Fix attempted: wording ("stress narrow eyes in beats; reroll seed").
5. Backstage #3 take 4 (`tke_neupodk9lgw1`), same fault: "Prompt wording did not fix it ... Best fix: Viggle Remake with an eye-fixed keyframe, keeping this motion." Take 5 (`tke_5g0g77jn48j9`, REMAKE): "Remake fixed the eyes". Stage: picture; a prompt rewrite failed, a painted keyframe + Remake held. Cost: 0.187 USD and 567 s for the Remake vs 0.059 USD and 178 s for the FL2VA take it repaired.
6. Backstage #4 take 2 (`tke_ehziu951bori`), action_timing: "the slide from hair to cheek happens in ~0.5 s (frames 16-28), then ~3.8 s is nearly still. Spec asked for a slow slide over 0-2.5 s." Two more takes followed, unreviewed. Stage: beat timing not obeyed by the model.
7. Umbrella a-tilted take 1 (R2VA): "Two open umbrellas plus a third closed one ..."; decision `2026-11-06T16:14`: carry the umbrella as a reference instead of text, drop the sidewalk reference, long shot instead of medium-long, remove `rain` vfx and rim light, "every beat names who holds the one umbrella". Stage: reference-slot allocation + catalogue phrase + wording.
8. Umbrella a-tilted takes 2–3: action_wrong, identity_drift, colour_drift, wardrobe_or_prop_lost, text_artifact persisted on R2VA; take 4 held after "changed: prompt, frames, R2VA → I2VA, 8 → 20 steps". Stage: mode/picture (a first frame replaced references).

**Planning errors caught in text**
- Story review `rev_aol6oh8vmcze` (`list_reviews(prj_pxz50vl9ahuw, story)`), reviewer `fresh_agent`, verdict `fail`, script v1. Four blockers: "Shot 2 overloaded: hands held, smile, notice collar, fix collar, startle+laugh, light change, both turn in 6 s"; "Four hands in one small area ... invites fused/extra fingers"; "Light change inside one shot"; "Rival layer invisible: nothing shows they compete in the same contest". Six minor findings include a mirror in the set, a unison head turn, timings that disagree with the sequence table. All fixed in script v2 (`rev_etgnzj0jl3ue`). The five later story reviews are `reviewer: self`.
- Retro lines "Shots that took three takes or more — plan them differently at the story stage" list 3 of 4 shots (Backstage), 1 of 2 (Umbrella), 5 of 10 (City Cat; three of them flagged fragile: chain, crowd, mirror), 1 of 2 (369), 5 of 13 rendered (`prj_u21g51xfupdx`).

**A plan built on a claim later retracted**
- Decision `2026-11-07T10:13` (`get_retro(prj_pxz50vl9ahuw)`): "Re-cut to 4 × 5 s single-action shots ... Updated guide: H3 holds one action well for ~5 s and cost per second quadruples above 10 s". Commit `859b081` retracts both halves: "the planner's fallback multiplied the per-second price by four above 10 s, from two compile_prompt estimates that differed because the GPU average had moved between the calls"; "no take data shows H3 holding an action better at 5 s, and faults turned up in 5 s takes too". The same shotlist later moved a shot back to 7 s to fix a timing fault (chain 2 above).

**Configuration errors that cost money**
- "update_look ... reset loras to [] ... Takes then rendered on the base chain at 20 steps (4 of 6 takes on one project)" — commit `cd0e3b4`; visible in `get_retro(prj_dv8phoozmfds)`: "4 take(s) rendered without a speed LoRA (base chain), 0.232 USD each against 0.143 USD with one"; `get_retro(prj_u21g51xfupdx)`: 20 takes on the base chain at 0.126 USD against 0.046 USD.

**Picture pipeline faults** — `docs/picture-quality.md:26-37`: ten problems found in the Codex image path, e.g. reference images probably never reached generation (#3), "Character reference sheet" wording produced multi-figure sheets with labels (#4), one-sided features mirrored (#6), no person count (#7). All are prompt/plumbing for the *image* model; fixes at `:41-53`.

**Git history, 67 visible non-merge commits (my classification from subjects)**
- UI, brand, i18n, mobile: ≈ 29 (e.g. `6f3a100 feat(ui): five pages and two layers`, `63005d4 feat(ui): EN / 中`).
- Picture pipeline / elements / image models: ≈ 8 (`bbd28f2 feat(elements): a character's sheet in the order identity is built`, `d8e60c1 feat(elements): a face view`, `e6c73de feat(images): MiniMax H3 Image, self-hosted`, `7f3230c`, `f389ece`, `7d4b1ce`, `558086c`, `4fc4771`).
- Face check / provenance: 5 (`9748136`, `af2e418`, `4fde401`, `0e76636`, `8c009a8`).
- Voice and sound: 6 (`700ea49 feat(voice): voice cards ... dialogue in H3's own format`, `8705b8e`, `ffe4f02`, `d829b97`, `3759a49`, `4cf72cd`).
- Planning / director rules / lint / review gate: ≈ 6 (`859b081 fix(director): one frame grid, linear cost, one length rule`, `7a6c494 feat(director): the plan is kept and held to`, `e4afa31 feat: script coverage`, `cd0e3b4 fix(director): ... a real shot-review gate`, `8fec588 feat(lint)`, `ef67feb feat(loras): LoRAs are per shot, assigned by the director`).
- Prompt wording / compiler / styles: ≈ 6 (`26bd57e feat(look): constraints are statements — H3 has no negative prompt`, `caeb197 feat(prompt): the presets' constraints and the speech rule say what is there`, `716f12d fix(styles)`, `11b86d6`, `93dccfb`, `3a2f514 fix(models): the base chain runs at the model's own sigma shift`).
- Edit / assembler: 1 (`aa2f66d feat(assembler): J/L cuts, transitions, titles, narration, silences, loudness; checks on the file`).
- Infrastructure / access / deploy / housekeeping: ≈ 6 (`5ba6668`, `22f0070`, `87d88e3`, `153ef21`, `f8c9450`, `9be940d`).

### Inferences
- By stage, the eight recorded fault chains split roughly: picture/frame/mode cause or fix in 5 (chains 2, 3, 4–5, 7, 8), prompt-versus-frame contradiction in 1 (chain 1), time allocation in 2 (chains 2, 6). No chain was resolved by rewording a beat alone; in chain 5 the record says so explicitly. This contradicts, on a very small sample, the guide's assertion "Most rerolls are prompt mistakes, not model failures" (`DIRECTOR.md:128`), unless "prompt mistakes" is read broadly as "spec inconsistent with the frames".
- Identity and prop faults were fixed by pictures (new end frame, first frame instead of references, Remake); action and timing faults were fixed by re-allocating time or accepted after retries. The project's own fix order encodes this: trim → timeline → Remake for picture faults → only then revise wording (`agent/director.md:82`), and "a re-render of the same input usually fails the same way".
- The take in chain 4–5 contained three negated phrasings about the very feature that drifted ("eyes that never widen", "never big round anime eyes", "no double eyelid crease") in a model where "a ban is drawn as the thing it bans" (`AGENTS.md:43`). The records do not test whether the negations caused the drift; it is consistent with the project's own rule and with the `wording.negation` lint (`craft.ts:120`).
- The only independent story review on record caught an overloaded shot, a four-hands close-up, an in-shot light change and a missing story premise at zero GPU cost; the later take faults in that project (simultaneous motion, action timing) are the same family as the minor findings it flagged as "watch whether the catch lands". That is one case, not a rate.
- Within the visible git window, prompt-wording commits and planning-rule commits are equal in number (≈ 6 each), and both are outnumbered by picture-pipeline work (≈ 8 + 5) and UI (≈ 29). The planning commits changed *what is enforced* (`7a6c494`, `cd0e3b4`, `e4afa31`); the prompt commits removed text (bans) rather than adding craft.

### Gaps
- 68 of roughly 79 finished takes have no review, so "what failed" is unknown for most of the spend. No take in any project was tagged by a human on the Board as far as the records show (reviews are `by: agent`, basis: stills).
- No film review and no export-level record exist; nothing in the records speaks to edit or sound failures in a finished film.
- No project has a passing fresh-reviewer shot review, so the shot-review gate's catch rate is unmeasured.
- The git window (five days, PR #27 onward) omits the period in which the compiler, lints and first director sessions were built; the commit classification cannot be read as the project's whole history.
- I did not read `list_decisions` separately; decisions cited are those embedded in the retros.

---

## 6. What is explicitly unmeasured or a default

### Takeaway
The project marks shot length versus quality, dialogue accuracy, every prompt experiment, every style LoRA, the fragility score and the constraint rewrites as unmeasured; the only quantities measured on takes are GPU time per output second and the fault tags of 11 reviewed takes.

### Cited Findings
- **Shot length and quality.** "Shot length and quality are unmeasured. The 5 s default for action shots is a default from cost. Do not cite it as a finding until the length A/B (12 s against 6 + 6 `continuous`) has been run." — `AGENTS.md:40`. "Length and quality: not measured. The default (5 s for an action, at most 8 s, 10 s for a hold) rests on cost and on a prior from similar video models, not on H3 takes: identity drift and mistimed actions turned up in 5 s takes too." — `TECHNIQUE-H3.md:10`. "What is not known yet: whether H3 holds an action better at 5 s than at 10 s ... no review so far blames length." — `agent/director.md:19`. `MAX_ACTION_S = 8` is "A default from cost, not a measured limit" — `shotlist.ts:116-117`; `duration.complex` is an info-level hint — `shotlist.ts:71-76`. [default]
- Stale assertions of the same claim remain in code: "H3 holds one action per 5 s; split the chain across shots" — `craft.ts:36`; "H3 averages the turns" — `craft.ts:78`. [asserted; contradicts `AGENTS.md:40`]
- **Cost vs length.** "about 1.4 times, on small samples that mix workflows and orientations": PRO 6000 ≈ 19 GPU-s per output second under 6 s (n=18) vs ≈ 27 at 7.3–10.1 s (n=5); RTX 5090 ≈ 30 (n=1) vs 49 (n=6) — `TECHNIQUE-H3.md:9`. [measured, small n] The estimator itself is linear with a step factor `steps/8` — `src/studio/cost.ts:14-20`.
- **Dialogue.** "Mandarin accuracy and lip-sync are not yet measured on the self-hosted model" — `agent/director.md:95`, `TECHNIQUE-H3.md:41`; `fragile.dialogue`: "spoken lines are unverified on H3" — `craft.ts:85`.
- **Voice experiments** `voiceRefs`, `audioFirst`: "Compare against plain takes before relying on either." — `agent/director.md:96`.
- **Prompt experiments** `frameHolds`, `restateFrame`, `positiveCast`: "Each changes text the turbo LoRAs were trained on; A/B them on one shot before a project default" — `TECHNIQUE-H3.md:49`; `agent/director.md:108` ("Under test"). No retro shows an experiment run (every "Experiments" column is "—").
- **Style LoRAs.** "none of the library's style LoRAs has been measured on H3 with these graphs" — `agent/director.md:117`; `DIRECTOR.md:127`; commit `7a6c494`: "style LoRAs stay suggestions until one has been rendered with its preset".
- **Fragility score / careful tier.** "unmeasured on H3, so treat it as a hint" — `TECHNIQUE-H3.md:110`.
- **Portrait references.** "Unmeasured on H3: whether a portrait reference pulls the framing toward a close-up" — `TECHNIQUE-H3.md:48`.
- **Constraint rewrites and speech rule.** "Unmeasured: nothing here was rendered." — commit `caeb197`.
- **Aspect ratios.** "Other aspect ratios are untested." — `TECHNIQUE-H3.md:7`.
- **Prompt rules in general.** Planned P0 prompt evaluation not run: "评测本身待 P0" — `docs/cinema-studio-h3-design.md:1154`; "§9 P0 实测 | 未做 ... 成本常量和 prompt 规则仍是占位" — `:1163`. (That appendix predates `gpu_stats`; cost is now measured, prompt rules are not.)
- **Image pipeline.** Unverified items: whether `codex exec -i` actually feeds references to the image tool; cost and agreement rate of the self-check — `docs/picture-quality.md:55-58`.
- **Assembler.** "Not run here: the assembler image build and the font install on a pod." — commit `aa2f66d`. Not yet possible: timing an on-screen line from the take's own sound — `TECHNIQUE-H3.md:88`.
- **Guide assertions with no data in the repo**: "Most rerolls are prompt mistakes, not model failures" (`DIRECTOR.md:128`); "The storyboard decides the film more than the plot does" (`DIRECTOR.md:63`); "Prefer an episodic structure. Shots that need not match each other are the safest" (`DIRECTOR.md:37`); the fragile-pattern list "Each raises the reroll rate" (`DIRECTOR.md:36`, `craft.ts:27-29`); "`static` ... the move H3 drifts least on" (`DIRECTOR.md:109`). [asserted]
- **Observation limits.** The agent's take reviews are on stills only ("basis: 4 fps contact sheet ... sound not heard", every review in `get_shotlist(prj_pxz50vl9ahuw)`); `agent/director.md:29`.

### Inferences
- A final report can state as measured: the H3 input constraints (from the handoff graphs), GPU seconds per output second per GPU type, per-take costs, and the specific fault chains in section 5. It cannot state as measured: any optimal shot length, any benefit of a lint rule, any benefit of a particular wording rule, or any rate at which planning versus prompting causes retakes.
- The project's own correction (`859b081`) is a documented case of an LLM director turning two noisy estimates into a planning rule ("cost per second quadruples above 10 s") and a re-cut of a real shotlist.

### Gaps
- The length A/B (12 s vs 6 + 6 `continuous`) has not been run; no record of a plan to run it beyond the instruction in `AGENTS.md:40`.

---

## 7. Cost and time per take, and what a retake costs relative to planning

### Takeaway
A take costs roughly 0.05–0.23 USD and 2.5–9.5 minutes of GPU wall time; a second of video costs about 0.015–0.020 USD at 8 steps. Text-stage work (script, treatment, shotlist, lint, reviews) costs no GPU money, and in the reviewed projects 31–59 % of takes were retakes of a shot that already had one.

### Cited Findings
- `gpu_stats()` (2026-11-13): RTX 5090 — 45 takes, 12,172 generation seconds, 265.1 video seconds, 45.92 GPU-s per output second, 1.19 USD/h, 0.0152 USD per video second. RTX PRO 6000 Blackwell — 34 takes, 5,803 s, 198.3 video seconds, 29.26 GPU-s per output second, 2.49 USD/h, 0.0202 USD per video second. [measured]
- Handoff timings: 5 s (124 frames), A100 80 GB, turbo 8 steps, 1344×768: T2VA 180 s warm, FL2VA 229 s warm, I2VA 296 s cold, R2VA 392 s cold — `HANDOFF.md:89-96`. 10 s (243 frames), PRO 6000: R2VA turbo 278 s, I2VA turbo 263–280 s, 20-step base 608–613 s, R2VA base 804 s; RTX 5090 20-step 932 s — `HANDOFF.md:104-109`. [measured, single runs]
- "A 20-step take (no speed LoRA) costs 2 to 2.5 times an 8-step one." — `TECHNIQUE-H3.md:9`; retros: 0.232 vs 0.143 USD (`prj_dv8phoozmfds`), 0.126 vs 0.046 USD (`prj_u21g51xfupdx`).
- Individual takes, `get_shotlist(prj_pxz50vl9ahuw)`, RTX 5090, FL2VA turbo 8 steps, 768×1344: 5.17 s outputs took 147–302 s and cost 0.049–0.100 USD; 5.88 s: 178–254 s, 0.059–0.084 USD; 7.29 s: 317 s, 0.105 USD. Viggle Remake of a 5.88 s take: 371 s / 0.123 USD and 567 s / 0.187 USD.
- Per project (`get_retro`): Backstage 14 takes for 4 shots, 1.16 USD on takes of 1.56 spent (cap 10); Umbrella 6 takes for 2 shots, 1.22 of 1.84; City Cat 27 takes for 10 shots, 2.00 of 2.36; 369: 4 takes for 2 shots, 0.58 of 0.74; `prj_u21g51xfupdx`: 31 takes for 13 rendered shots, 3.02 of 3.68.
- Per-shot retake cost recorded: Backstage #3 six takes 0.59 USD; Umbrella a-tilted four takes 0.87 USD; City Cat morning-alley #2 five takes 0.55 USD — `get_retro` "Carry forward".
- Why the default is short shots: "a retake of a short shot costs less" — `agent/director.md:19`. Base-model switch ≈ 2 minutes — `agent/director.md:20`.
- Budget rules: every spending tool answers `needs_confirm` with an estimate; previz is one take per shot — `agent/director.md:87, 122`.
- Pictures: "Pictures cost little and catch mistakes before a take costs a lot" — `agent/director.md:36`. Self-check adds "大约 30–90 秒" per picture on Codex usage, not image quota — `docs/picture-quality.md:58`.

### Inferences
- Average take from `gpu_stats`: RTX 5090 ≈ 270 s for ≈ 5.9 s of video ≈ 0.089 USD; PRO 6000 ≈ 171 s for ≈ 5.8 s ≈ 0.118 USD (computed from the totals above).
- Retake share (takes beyond the first per rendered shot): Backstage 10 of 14 (71 %); Umbrella 4 of 6 (67 %); City Cat 17 of 27 (63 %); 369: 2 of 4 (50 %); `prj_u21g51xfupdx` 18 of 31 (58 %). Across these five projects 51 of 82 takes (62 %) were second or later takes of a shot. Some are deliberate alternates, not rejections (the retros count only 2–3 "rejected" per project), so this is an upper bound on waste.
- Absolute money is small (a whole project is 0.6–3.7 USD); the scarce resource in the records is wall time and attention: each retake is 2.5–9.5 minutes of GPU plus a review on stills, and a linked shot cannot render until its anchor's take is picked (`agent/director.md:21`). A text-stage fix (a re-split shot, a removed in-shot light change) costs none of that.
- The picture stage is not free in effort: 84 pictures for 4 shots with 50 edits and 29 of 76 self-check failures in one project means the still stage absorbed many iterations before, and during, the take stage.

### Gaps
- The Studio records no USD cost for planning or for pictures drawn by Codex on a ChatGPT plan; the difference between "spent" and "on takes" (e.g. 0.40 USD in Backstage) is not broken down in the retro. A numeric "retake versus planning" ratio therefore cannot be computed from the records, only "retake cost versus zero GPU cost".
- No record of agent token cost or session time for planning, lint or reviews.
- `gpu_stats` mixes workflows, orientations, step counts and cold/warm starts; the per-second figures are averages, not per-mode costs.
