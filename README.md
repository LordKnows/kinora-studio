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
`/api/cron/sweep` and `/media/*` (unguessable keys), which carry their own
auth (OAuth bearer, HMAC, secret). `AUTH_MODE` fails closed: anything but
`dev` means Access.

### 3. Connect the director

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
workers/h3-runpod/       ComfyUI serverless handler for H3
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
