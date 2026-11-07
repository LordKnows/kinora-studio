# Painter

Draws the Studio's pictures away from the GPU: character sheets, first and
last frames, region edits, style frames, Remake keyframes, push-in crops and
frames extracted from takes. Run it on a small always-on machine — a RunPod
CPU pod, a VPS, a spare computer — and every picture is ready before the GPU
pod is started. The GPU pod runs the same loop as a fallback while it is up
(`PAINTER_ON_POD=0` on the Worker turns that off).

```
Studio (D1 queue)  ◄── POST /api/painter/claim  (heartbeat: what it can draw; answer: jobs, commands)
       │           ◄── POST /api/painter/jobs/<id>/uploads  (presigned PUTs for its own keys)
       │           ◄── POST /api/painter/jobs/<id>/done     (urls, size, checks, self-review)
painter.py ──► paint.py ──► codex exec (ChatGPT plan) | images API ──► R2
```

The painter only calls out: no open port, no R2 keys. A job it stops
reporting (it died, it restarted) goes back to the queue after a few minutes;
after three losses the job fails.

## Run

```bash
export STUDIO_URL=https://studio.example.com PAINTER_TOKEN=...   # the Worker's PAINTER_TOKEN (or STUDIO_WORKER_TOKEN)
bash run_painter.sh            # installs ffmpeg/Pillow/Codex if missing, then runs painter.py
```

or with Docker:

```bash
docker build -t cinema-painter workers/painter
docker run -d --restart unless-stopped -v painter:/data \
  -e STUDIO_URL=https://studio.example.com -e PAINTER_TOKEN=... cinema-painter
```

On a RunPod CPU pod: any Python image, a volume at `/workspace` (the Codex
login and the painter id are kept in `/workspace/painter`), and as the start
command the bundle one-liner from the Machine page. Add `/api/painter/*` and
`/api/pod/*` to the Cloudflare Access bypass application.

To pay only while it draws, let the Studio start and stop that CPU pod:
Machine page → Painters → **Painter pod** → paste its RunPod id → **Take over**.
It starts when pictures are queued and no painter can draw them (1–3
minutes to boot), and stops after `PAINTER_IDLE_STOP_MINUTES` (default 10)
with nothing to draw or log in. The painter reports `RUNPOD_POD_ID`, which is
how the Studio knows the painter is up. The Studio never creates or deletes
the pod.

Then open the Machine page → Painters → **Log in with a device code** (once;
the login is kept in `PAINTER_STATE_DIR`, and a refreshed token is written
back there).

| Variable | Default | |
|---|---|---|
| `STUDIO_URL`, `PAINTER_TOKEN` | — | required |
| `PAINTER_NAME` | host name | shown on the Machine page |
| `PAINTER_SLOTS` | 2 | pictures at once |
| `PAINTER_STATE_DIR` | `/workspace/painter` or `~/.cinema-painter` | painter id + Codex login |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `IMAGE_MODEL` | — | the images API backend |
| `CODEX_PAINT_MODEL`, `CODEX_REVIEW_MODEL` | Codex default | models for drawing / the self-check |
| `CODEX_PAINT_TIMEOUT_S`, `CODEX_REVIEW_TIMEOUT_S` | 900 / 300 | |

## What it checks

Every picture comes back with `checks` (measured on the pixels: blank,
borders or letterbox bars, the share cropped to reach the render's aspect, a
busy sheet backdrop, an edit that changed far more than asked) and, with the
project's self-check on, `review`: a fresh `codex exec` looks at the picture
beside its references and its brief and answers a rubric as JSON (anatomy,
count, identity, mirrored features, text, framing, style, background, edit
scope). A blocker is redrawn once with the findings added (the project's
"redraws on a blocker"; each redraw counts against the image quota). See
`docs/picture-quality.md` for why.

## Tests

```bash
python3 -m pytest -q workers/painter
```
