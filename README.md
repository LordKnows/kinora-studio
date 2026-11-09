# Cinema Studio — an open Cinema Studio on self-hosted MiniMax H3

A film-crew workflow in the browser: **script → elements → shotlist → hero
frames → takes → timeline → export**. The director is your own subscription
Claude or Grok, connected over MCP. Video renders on **MiniMax H3-Base** running
on your RunPod endpoint. Hero frames and element references are uploaded (a
still-image backend is a TODO). Everything is stored in R2 and a small
SQLite/D1 database. Deploys to Cloudflare Workers.

The original single-shot studio is still here at `/playground`.

Design: [docs/cinema-studio-h3-design.md](docs/cinema-studio-h3-design.md).

---

## How it fits together

```
 Claude / Grok (your subscription) ──MCP + OAuth──►  /mcp
                                                       │
 Browser (Cloudflare Access) ─────────REST───────────►  Studio (Next.js on Workers)
                                                       │  compiler · checkpoints · budget · orchestrator
                           ┌───────────────────────────┼───────────────────────────┐
                           ▼                           ▼                           ▼
                 RunPod H3 worker              RunPod assembler            Uploads (R2)
                 (ComfyUI, 768p + audio)       (ffmpeg, CPU)               (hero frames, refs, music)
                           └──────────── writes to R2 ◄────────────────────────────┘
```

- **One shot = one H3 request.** A shot is structured data (beats, camera,
  dialogue, sound, references); the compiler turns it into an H3 prompt in the
  community-documented format, with the project Look on every shot. Four modes:
  `text`, `keyframe` (hero frame, optional end frame), `reference` (≤3 refs),
  `edit` (revise a take).
- **Two human checkpoints.** The latest script and the shotlist must be
  approved on the web before anything renders. Approval is web-only; the agent
  gets `not_approved` and tells you which page to open.
- **Money asks first.** Every paid tool returns an estimate and `needs_confirm`
  until called with `confirm: true`; projects have a budget cap.
- **The GPU is a pod you can see.** The studio creates one RunPod pod from
  your ComfyUI image, restricted to an allow-list of GPU types, starts it on
  the first render, shows status/uptime/cost in the rail, and stops it after
  idling. "暂时没资源" when none of the allowed GPUs has capacity.
- **Every take is a data point.** Completed takes record their GPU type,
  hourly price and output seconds; the Settings page ranks GPU types by USD
  per second of video, estimates switch to measured speed, and
  `RUNPOD_GPU_PRIORITY=cost` orders the allow-list by that ledger.
- **LoRAs are a library.** `/loras` holds speed and style LoRAs with their
  HuggingFace links; projects pick defaults in the Look, shots can override,
  and the pod downloads a missing file before rendering.
- **The director has three tiers.** `start_film` takes the brief and the
  running time and returns the plan: Tier 2 is an edit grammar (cut,
  continuous, bridge, insert/return, shot/reverse, match cut, jump cut,
  montage) the compiler executes by feeding anchor frames to the right H3
  workflow; Tier 3 is a cinematography vocabulary (framing, lens, light,
  grade, texture, VFX, animation style, pace) validated by the schema and
  rendered into the prompt. `agent/editing.md` and `agent/cinematography.md`
  are generated from the catalogs.
- **Errors stop before the spend.** Each shot is staged in screen terms
  (blocking, what moves, composition on the 38/62 lines, first and last
  frame written before they are drawn), each scene has a colour script, and
  a colour-block storyboard is drawn from the shotlist before any frame.
  A fresh reviewer reads the story, every shot before it renders and the
  cut (`review_packet` → `record_review`); `generate_take` warns until the
  exact prompt and frames passed, and refuses to blindly re-render a
  rejected input inside the spend envelope the user grants on the web. The
  lint flags the pictures AI video gets wrong; the batch renders the most
  fragile shots first; a retro counts what went wrong for the next film.
- **Pictures before takes, with the model the user picks.** With the
  per-project switch on (Settings → Director → *Allow image generation by
  agent*), character sheets, first and last frames, region edits and style
  frames are drawn with the project's image model — the same models as
  Canvas, but Qwen-Image-Edit 2509, which only composes a portrait or costume
  with a pose. GPT Image (Codex on the user's ChatGPT plan, device-code login
  from the Machine page, or the images API) and Qwen-Image 3.0 Pro (API) are
  drawn by a **painter** — `workers/painter`, a small always-on machine (a
  RunPod CPU pod, a VPS) that claims image jobs from the Studio — so those
  pictures are ready before the GPU pod starts; Qwen-Image 2.1 draws on the
  GPU pod while it runs, with the LoRAs the user picks for it there (each
  card's settings applied; an 18+ LoRA needs 18+ on and draws only from
  pictures the Studio drew or the reference library, never from an upload or
  an imported picture). With *Agent use Canvas* on, the director may also
  compose a character's look from the Canvas library (`compose_character`)
  when it judges one is needed, with the same model. A picture takes the
  model's settings, at most its number of reference pictures (the prompt
  names only those), and its way of naming them (`<imageN>` for Qwen-Image 2.1). Buttons on every page and
  the director (following a picture plan: reuse, crop, edit, then draw) queue
  them. Each picture comes back with pixel checks and a Codex self-check
  (a blocker is redrawn once with the findings), then a fresh reviewer's
  coded rubric decides before a take is built on it.
- **Pictures have names.** Every picture has a handle (`IMG-12`) and a name,
  so "redraw IMG-12" means one picture; the Pictures page lists them all with
  where each is used, and any grid deletes a batch.
- **Fix a take without rerolling it (Viggle Remake).** Paint one or two
  frames right, say what changes, and the take is re-shot with its motion,
  camera, timing and sound kept: props, wardrobe, faces, backgrounds.
- **The agent calls us.** No LLM API keys anywhere: the studio is a remote MCP
  server with its own OAuth 2.1, so Claude's and Grok's custom connectors can
  attach. `agent/director.md` is the director guide, served as a tool and a
  resource and pasteable into your chat client.

## Run it locally

```bash
pnpm install
cp .env.example .env.local   # AUTH_MODE=dev is enough to click around
pnpm dev                     # http://localhost:3000
```

Without RunPod / R2 keys the studio still lets you build a project,
script, elements, shotlist and compile prompts; generation buttons report what
is missing. Tests:

```bash
pnpm test        # vitest: pipeline, compiler, checkpoints, OAuth, assembler input
pnpm typecheck
```

Connect Claude Code during development with a static token:

```bash
MCP_STATIC_TOKEN=devtoken pnpm dev
claude mcp add --transport http studio http://localhost:3000/mcp --header "Authorization: Bearer devtoken"
```

## Deploy

### 1. RunPod (pod mode)

- Build `workers/h3-runpod/Dockerfile.pod` on top of your ComfyUI image
  (custom nodes and LoRAs baked in; the big H3 weights on a network volume)
  and push it; set `RUNPOD_POD_IMAGE`, `RUNPOD_NETWORK_VOLUME_ID`,
  `RUNPOD_GPU_TYPES` and `STUDIO_WORKER_TOKEN`. The pod runs
  `workers/h3-runpod/server.py`, a small job server that renders with the
  H3 graphs (`workers/h3-runpod/handler.py`) and assembles exports with
  ffmpeg (`workers/assembler/handler.py`), uploads to R2 and calls the
  studio's signed webhook.
- Drop the T2VA / I2VA / FL2VA / R2VA API-format workflows into
  `workers/h3-runpod/workflows/` and fill `mapping.json`.
- If the model volume is a *global* network volume, the REST API cannot
  attach it yet. Create the first pod in the RunPod console with the values
  from Settings → GPU pod → "Show what to paste into RunPod", then adopt
  it by id; the studio runs it but never terminates or replaces it.
- Serverless endpoints (`RUNPOD_MODE=serverless`) are still supported in
  code but are a TODO, not the default.
- Pick a data-center region that the MiniMax Community License allows (it
  excludes the US, EU, UK and South Korea). That is the deployer's
  responsibility; see the design doc §2.3 and §10.

### 2. Cloudflare

```bash
wrangler d1 create studio            # put the id into wrangler.jsonc
wrangler r2 bucket create studio     # served by the app at /media/* (R2_PUBLIC_BASE_URL=https://<studio>/media)
pnpm db:emit                         # writes migrations/*.sql from src/db/migrations
wrangler d1 migrations apply studio --remote
wrangler secret put RUNPOD_API_KEY   # and the rest listed in wrangler.jsonc
npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy
cd workers/cron && wrangler deploy   # minute-by-minute sweep → /api/cron/sweep
```

Put the studio hostname behind **Cloudflare Access** (set `AUTH_MODE=access`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`) and add bypass rules for `/mcp`,
`/.well-known/*`, `/api/oauth/*`, `/api/runpod/hook`, `/api/assembler/hook`,
`/api/cron/sweep`, `/api/painter/*`, `/api/pod/*` and `/media/*` (unguessable
keys), which carry their own auth (OAuth bearer, HMAC, secret, token). `AUTH_MODE` fails closed: anything but
`dev` means Access.

### 3. A painter (pictures, off the GPU)

Set the Worker secret `PAINTER_TOKEN` (or reuse `STUDIO_WORKER_TOKEN`), then on
any small always-on Linux machine:

```bash
export STUDIO_URL=https://<studio> PAINTER_TOKEN=<the secret>
mkdir -p ~/cinema-painter && curl -fsSL "$STUDIO_URL/api/pod/bundle?token=$PAINTER_TOKEN" | tar xz -C ~/cinema-painter
bash ~/cinema-painter/h3-runpod/run_painter.sh
```

or `docker build -t cinema-painter workers/painter` and run it with a volume
on `/data`. It appears on the Machine page; log Codex in there once. See
`workers/painter/README.md`.

### 4. Connect the director

- **Claude**: Settings → Connectors → Add custom connector →
  `https://<studio>/mcp`. The OAuth consent page is the studio itself.
- **Grok**: grok.com → Connectors → New → Custom → same URL.
- Paste `agent/director.md` into the project instructions, or let the agent
  call `get_director_guide` first.

## Layout

```
agent/director.md        the director guide (source of truth; emitted to src/mcp/guide.ts)
agent/editing.md         Tier 2 edit grammar (generated from src/studio/editing.ts)
agent/cinematography.md  Tier 3 vocabulary (generated from src/studio/cinematography.ts)
docs/                    design document
migrations/              SQL emitted for wrangler d1 (pnpm db:emit)
src/app/                 pages (/, /p/[id]/…, /playground, /oauth/authorize) and /api routes
src/studio/              schemas · types · repo · compiler · checkpoints · cost · orchestrator · backends · storage
src/mcp/                 MCP server (tools + resource)
src/oauth/               OAuth 2.1 authorization server for connectors
src/auth/                Cloudflare Access JWT, bearer tokens, HMAC
src/db/                  SQLite (Node) / D1 (Workers) and migrations
src/studio-ui/           the studio pages' components and styles
src/generation/          the original catalog + platform client (/playground only)
src/openhiggsfield/      the original single-shot studio (/playground)
workers/h3-runpod/       ComfyUI handler for H3 and the pod's job server
workers/painter/         the painter: draws pictures (Codex / images API), crops, extracts frames
workers/assembler/       ffmpeg serverless handler
workers/cron/            scheduled Worker that triggers the sweep
src/studio/gpu.ts        pod lifecycle: create on the allow-list, start/stop, auto-stop, replace, per-GPU stats
tests/                   vitest
```

## API

`src/app/api/**` implements the endpoint list of the design doc §7.2. Every
error is `{ error: { code, message, details } }` with the codes `validation`,
`unauthorized`, `forbidden`, `not_found`, `not_approved`, `needs_confirm`,
`budget_exceeded`, `backend_error`. MCP tools are the same operations with the
same zod schemas (`src/studio/schemas.ts`).

## What is measured, not assumed

The cost model (`RUNPOD_SECONDS_PER_OUTPUT_SECOND`, `RUNPOD_GPU_USD_PER_SECOND`)
and the prompt rules in `agent/director.md` carry placeholders until the P0
measurements in the design doc §9 are done on your endpoint. The settings page
has an eval mode for blind A/B scoring of takes.

## Regenerate 2K

NVIDIA's open Open-H3-Regenerate-2K replaces MiniMax's API-only
high-resolution stage: a completed 768p take is re-generated at 1080p / 2K /
4K in three refine steps on the pod (Board button or `regenerate_take`), the
file sits beside the take, and the `master-upscaled` export uses it. The pod
installs the node packs and downloads the ~21 GB of weights at boot
(`REGEN_2K=1`).

## The pages

Top bar on every surface (project crumb, GPU pill, Projects / Canvas / Library /
Machine / Connect). Inside a project the rail follows the order of work:
**1 Brief & style** (brief and running time; the style, a preset compiled
into its fields; aspect ratio; LoRAs; up to three style frames, generated or
uploaded — each card saves on its own), **2 Script** (versions, rendered
markdown, approval), **3 Elements**, **4 Board** (shot cards with cinematography codes, link and lint badges; Lint,
Apply style and Render batch in the toolbar; the shot drawer), **5 Finals**
(the pick per shot at the size it was rendered at; all picks regenerated at
1080p / 2K / 4K in one go), **6 Timeline** (every selected take from 0 s at
full length by default, Reset to rebuild; rough cut, beat grid, audio mix,
subtitles check, export). Pictures lists every picture; editing a region of
one happens there. Global pages: Canvas
(compose a character from the reference library, below), Library
(styles + LoRAs), Machine (the pod), Connect (MCP). Geist Sans / Geist Mono,
one accent reserved for the primary action, the selection and "running".

## Director layer (`packages/director`)

Judgement helpers that sit beside the Studio's own tools. **They are served
from the Studio MCP connector** (`list_styles`, `suggest_styles`, `get_style`,
`compile_look`, `apply_style`, `lint_shotlist`, `validate_treatment`,
`check_cue_map`, `cut_on_beats`, `check_subtitles`, `plan_batch`,
`check_timeline`, and `get_director_guide` sections `judgement` / `technique` /
`styles`), so Grok and Claude get them through the same connector; the package
also runs as a local stdio MCP for the two tools that need a machine
(`assemble_local` with ffmpeg, `synthesize_narration` with edge-tts). What it
adds: 16 style presets (eleven-section
`STYLE.md` convention) compiled into Studio fields, a treatment validator, a
rhythm lint for shotlists, a cue map that snaps cuts to the beat, an extended
timeline (J/L cuts, fades, titles, narration, ducking) assembled locally with
ffmpeg, subtitle reading-time rules and a batch planner. Registered in
`.mcp.json` as `director`; see [`packages/director/README.md`](packages/director/README.md).

```bash
pnpm --filter @openhiggsfield/director build
pnpm --filter @openhiggsfield/director test
```

## Canvas: the reference library

`/canvas` composes one character picture from a **portrait** (face, hair), a
**costume** and a **pose** — picked from a library of 1,439 pose pictures
(grey mannequins, 288 poses × 5 camera angles, line art or depth map), 3,224
costumes (ギア photo-real and anime, CharaDB, Shisei Chinese historical) and
1,499 portraits (AI-generated adults), or uploaded — plus more pictures up
to what the model takes. The pose can be flipped left to right (*⇋ 镜像*;
the painter mirrors the picture before drawing, and the prompt says so). The
prompt is composed for you (each picture named by its place and
given one job, ported from anhao/ai-pose-gallery-zh) and can be edited; GPT
Image draws it on a painter into a project (`IMG-n`, recipe in
`meta.canvas`), optionally straight onto an element as a reference view.
The director gets the same library through `list_references`,
`get_reference` and `compose_character`.

- **Your own pictures.** A face, an outfit and a pose can be uploaded; an
  uploaded pose says what it is (照片 a photo — only the pose is taken, 白模
  a mannequin or line art, 深度 a depth map). A project character can stand
  in for the portrait (its sheet is the face and, without a costume, the
  outfit).
- **Text to image (文生图).** Switch the recipe to *文生图 · Text* and
  describe the picture: no reference is needed, and the style, size, model
  and LoRAs still apply (GPT Image, Qwen-Image 3.0 Pro, Qwen-Image 2.1 —
  not Qwen-Image-Edit 2509, which composes a pose from pictures).
- **Two people (双人).** Person A and person B each get a portrait and a
  costume (or a project character), with one two-person pose — the library's
  双人 poses or an upload — and *Person A in the pose* says which figure is
  whom (left, right, front, back, top, bottom); each can be named. The
  prompt binds every picture to its person and keeps the two apart. GPT
  Image takes up to five pictures, Qwen-Image 2.1 ten; not Qwen-Image-Edit
  2509. Character sheets keep the faces apart best.

- **Metadata only.** `src/studio/references-data.ts` is generated by
  `node scripts/import-references.mjs <checkout of anhao/ai-pose-gallery-zh>`.
  No picture is mirrored: thumbnails load from the galleries themselves, the
  painter downloads the three to five pictures a job uses, and "Add to
  project pictures" fetches one picture into a project. The galleries allow
  one picture at a time as a generation reference (commercial work included)
  and forbid bulk download and redistribution; CharaDB pictures are never
  used on a real person's photo or for a minor (enforced for uploaded faces);
  portraits never impersonate a real person. With 18+ (a reference or a
  LoRA) every face must be AI-generated: a library portrait, or a picture the
  Studio drew whose faces are AI-generated in turn (`src/studio/provenance.ts`
  follows each face back through the jobs; outfits, poses, places and style
  frames are only borrowed, so uploaded ones are fine). An uploaded or
  imported face goes in when its face check — a vision model (TokenSail's
  `qwen3.7-plus`, or DashScope's Qwen-VL, with the Worker's
  `TOKENSAIL_API_KEY` / `DASHSCOPE_API_KEY`) looking once per picture
  (`src/studio/face-check.ts`) — finds a 3D render or an illustration of an
  adult who is no real person, or no face. A photograph, anything
  photorealistic, a real person's likeness, a minor, an unsure answer or no
  check at all keeps it out, and so does a drawing that kept such a face. The Chinese names and tags are
  anhao's translation, whose data is not under that repository's MIT licence:
  ask its maintainer before publishing them more widely.
- **18+ is hidden by default.** Two pose systems and the lingerie / sensual
  costumes (and CharaDB's own flag) are filtered out server-side until the
  signed-in user confirms they are an adult on the Canvas page (web only,
  stored per user in `user_settings`). The director sees what its user
  unlocked and cannot unlock it.

## Models and their settings

`src/studio/models.ts` is the registry of every model the Studio runs —
GPT Image (Codex / API), **Qwen-Image 2.1 Turbo** (Canvas, on the GPU pod),
MiniMax H3, Open-H3-Regenerate-2K, Viggle Remake — with the settings their
authors recommend (steps, CFG, sampler, schedule, shift), runtime, licence,
moderation and files. LoRAs carry theirs too (`loras.params_json`,
`base_model`; the seeded ones know their cards). A render resolves base model
→ workflow variant → speed LoRA → the caller's steps, so picking a model or a
speed LoRA sets everything; the Board's compile panel shows the settings and
where they came from. Library → Models lists it all; `list_models` gives it
to the director.

**Qwen-Image 2.1 Turbo on the GPU pod.** Image and video models share the
pod. With `QWEN_IMAGE=1` (default) the pod downloads Comfy-Org's ComfyUI
files (~17 GB: Turbo int8, Qwen3-VL 8B int8, VAE) after the H3 set; the
pod's painter then advertises `comfy:qwen-image-2.1-turbo` and draws Canvas
pictures in ComfyUI (`workflows/QWEN21_EDIT.json`, the official Turbo edit
template: 8 fixed steps, CFG 1, euler, up to ten reference pictures). It
draws only while the pod runs (Canvas offers *Start GPU pod*); queued
pictures keep the pod from idling out and never wake the CPU painter pod.
There is no content filter and no Codex self-review (it would send the
picture to OpenAI); an uploaded face is never combined with 18+ references.
Licence: Qwen Research License — non-commercial use only.

**Qwen-Image 2.1 (base) and LoRAs.** For LoRAs trained on the full model,
`QWEN_IMAGE_BASE=1` (default) adds the base int8 (7.3 GB; encoder and VAE
shared) when the disk has room, and Canvas offers the family's LoRAs under
the model. The library seeds **ChatR Labs' Omni v0.1** (an uncensored
rank-128 adapter: strength 1, 35 steps, true CFG 5): picking it sets those
settings; the painter fetches the file from HuggingFace into models/loras on
first use and chains it (`LoraLoaderModelOnly`) between the model loader and
the cache (`workflows/QWEN21_EDIT_BASE.json`, KSampler euler/simple, a
single-space negative above CFG 1). It is 18+: offered only once the user has
unlocked 18+, it never draws with an uploaded picture (an upload may be a real
person), and the adult line stays in any prompt. Its weights use
Diffusers/PEFT keys: if the pod's ComfyUI log says "lora key not loaded", the
adapter did not apply.

**Qwen-Image 3.0 Pro through an API (the pose gallery's 百炼 path).**
anhao/ai-pose-gallery-zh calls `qwen-image-3.0-pro` on Alibaba Cloud Model
Studio from the browser; here the CPU painter pod calls it — no GPU, and it is
not a ComfyUI model (the weights are not published). With `TOKENSAIL_API_KEY`
it goes through TokenSail's OpenAI-style `/v1/images/generations` (`image`:
the reference URLs, `size` `WxH`); with `DASHSCOPE_API_KEY` through
DashScope's own `multimodal-generation` endpoint, exactly as the gallery
does. Same composed prompt (图1/图2/图3), up to three pictures, `watermark`
off, and Canvas offers the gallery's `prompt_extend` (off by default: it
rewrites the composed roles) and a negative prompt. The vendor fetches the
references by URL, so the painter re-hosts them in R2 (`<job>.refN.jpg`,
mirrored when asked) and the Studio deletes them when the job ends. The
picture comes back as a URL that expires in about an hour and is fetched at
once; the cost TokenSail reports is kept in the job's output. Errors say what
to do (402: top up; 403: allow the model for the key; a moderation refusal is
named). Set the key as a Worker secret: the CPU painter pod gets it when it
is created (stop a running one once). Paid per picture and per reference;
Alibaba Cloud moderates every request.

**Qwen-Image-Edit 2509 (the pose gallery's workflow).** anhao/ai-pose-gallery-zh
draws its recipes with `qwen_image_edit_2509_3img` in ComfyUI; it is ported as
`workflows/QIE2509_3IMG.json` (portrait + costume + pose) and
`QIE2509_2IMG.json` (portrait or costume + pose, the original's two-picture
form). 图1 portrait and 图2 costume are pixel references (`ReferenceLatent`),
the pose reaches the model only through the text encoder, so the mannequin's
grey look never comes through. Lightning 4-step LoRA, shift 3, CFGNorm,
KSampler euler/simple, CFG 1. As in the original, the canvas takes the pose
picture's aspect at 1 MP (every library pose is 3:4; the picture is delivered
at 1008×1344 and the Size control is locked): a canvas the costume picture's
shape (2:3) made the model redraw the costume picture in place with the face
put in, and ignore the pose. The pose is followed loosely by design (text
encoder only, 4 Lightning steps). `QWEN_EDIT_2509=1`
(default) downloads ~31 GB (2509 fp8, Qwen2.5-VL 7B fp8, VAE, Lightning) when
40 GB are free; the painter picks the graph by the number of pictures
(`image_models.json` `min_images` / `variants`). Apache-2.0: commercial use
allowed. The container disk default is now 200 GB (everything in local-disk
mode is ~145 GB); a pod created at 120 GB keeps its disk when resumed —
terminate it once so the next Start creates a 200 GB one.

