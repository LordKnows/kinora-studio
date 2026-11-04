# h3-runpod — MiniMax H3 worker for RunPod Serverless

Renders one Studio shot per job on a ComfyUI graph, extracts the last frame
and four thumbnails, uploads everything to R2 and returns URLs. RunPod posts
the return value to the Studio's signed webhook.

## Job contract

Input (`event["input"]`), produced by `src/studio/compiler.ts`:

```json
{
  "workflow": "FL2VA",
  "prompt": "...", "negative": "no on-screen text, no logos",
  "seconds": 8, "video_size": "1344x768", "steps": 8, "seed": 1234, "enhance": false,
  "images": [{"url": "https://.../hero.png", "role": "first_frame"}, {"url": "https://.../end.png", "role": "last_frame"}],
  "video": null,
  "output": {"key": "projects/p1/shots/s3/takes/tke_1.mp4"},
  "studio_take_id": "tke_1"
}
```

Output:

```json
{"url": "...mp4", "last_frame_url": "...last.png", "thumb_urls": ["...thumbs/0.jpg", "..."], "execution_ms": 61234, "seed": 1234}
```

A failure returns `{"error": "..."}`, which RunPod reports as `FAILED`.
`{"input": {"action": "health"}}` returns ComfyUI reachability and the
templates found in `workflows/`.

## Deploy

1. **Network volume** ≥ 160 GB in the data centre you chose (mind the MiniMax
   licence territory). Populate it with the Comfy-Org H3 models once (the base
   image or a one-off pod can download them); after that keep auto-download off.
2. **Templates**: export your H3 graphs in API format into `workflows/` and
   write `workflows/mapping.json` (see `workflows/README.md`). Build and push
   the image: `docker build -t <registry>/h3-runpod:<tag> .`
3. **Endpoint**: GPU pool 96 GB (Blackwell), max workers 1, active workers 0
   (or 1 during a session to skip cold starts), FlashBoot on, execution
   timeout 900 s, attach the volume at `/runpod-volume`.
4. **Env vars** on the endpoint: `R2_ENDPOINT`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (write-only key for the bucket),
   `R2_PUBLIC_BASE_URL`, optionally `COMFY_URL`, `WORKFLOW_DIR`.
5. In the Studio set `RUNPOD_ENDPOINT_ID` to this endpoint. The Studio signs a
   `webhook` URL per take; nothing else needs configuring here.

## Test

```bash
curl -s -X POST https://api.runpod.ai/v2/$EP/runsync -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"input":{"action":"health"}}'
```

Then a 5-second T2VA job through `/run`, and watch `/status/<id>` or the
Studio board. Locally (ComfyUI on 8188, R2 env set):

```bash
python3 handler.py --local '{"workflow":"T2VA","prompt":"a lighthouse in rain","seconds":5,"video_size":"1344x768","output":{"key":"test/a.mp4"}}'
```

Unit tests: `python3 -m pytest workers/h3-runpod`.

## Cost notes

Serverless bills GPU seconds while a worker is up, including model load.
`execution_ms` in the output is what the Studio's ledger uses. Measure a 5 s,
10 s and 15 s clip at 8 steps on your pool and set
`RUNPOD_SECONDS_PER_OUTPUT_SECOND` / `RUNPOD_GPU_USD_PER_SECOND` in the Studio
so estimates match reality.
