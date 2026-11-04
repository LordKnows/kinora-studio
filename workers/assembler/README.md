# assembler — timeline → file on RunPod CPU Serverless

Takes the `AssemblerInput` the Studio builds from a timeline, cuts it with
ffmpeg, mixes an optional music bed, writes subtitles, uploads to R2 and
returns `{url, srt_url, duration_s, size_bytes}`. RunPod posts that to the
Studio's signed `/api/assembler/hook`.

## Input

```json
{
  "export_job_id": "exp_1", "preset": "master-768p", "video_size": "1344x768",
  "clips": [
    {"url": "https://r2/.../take1.mp4", "in_s": 0, "out_s": 8, "transition_in": "cut"},
    {"url": "https://r2/.../take7.mp4", "in_s": 0.5, "out_s": 6, "transition_in": "dissolve", "transition_s": 0.4}
  ],
  "audio": {"keep_clip_audio": true, "music_url": "https://r2/.../music.mp3", "mix_db": {"dialogue": 0, "sfx": -3, "music": -12}, "music_duck_under_dialogue": true},
  "subtitles": {"srt": "1\n00:00:00,000 --> 00:00:02,000\nMara: Not tonight.\n", "burn_in": false},
  "output": {"key": "projects/p1/exports/exp_1.master-768p.mp4"}
}
```

Presets: `master-768p` (the given `video_size`), `master-upscaled` (same for
now; the GPU upscale hop is a TODO in `handler.py`), `social-9x16`
(scale-and-crop to 768×1344), `preview-480p` (854×480, low bitrate).

## How it cuts

1. Each clip is trimmed (`in_s`/`out_s`), scaled and centre-cropped to the
   frame, conformed to 24 fps, h264 + aac 48 kHz stereo. Clips with no audio
   get silence. `mix_db.dialogue` is applied to the clip track (dialogue and
   sfx share that track; `mix_db.sfx` is accepted but unused until stems exist).
2. All-cut timelines use the concat demuxer (no re-encode). Any dissolve
   switches to an `xfade` + `acrossfade` chain; each dissolve shortens the
   total by its duration.
3. Music loops under the cut at `mix_db.music`, ducked by a sidechain
   compressor keyed on the clip audio when `music_duck_under_dialogue`.
4. The SRT is uploaded next to the mp4 as `.srt`; with `burn_in` it is also
   rendered into the picture.

## Deploy

CPU endpoint (2–4 vCPU, 8 GB), `max workers` 1–2, execution timeout 1800 s.
Env: `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_PUBLIC_BASE_URL`. In the Studio set `RUNPOD_ASSEMBLER_ENDPOINT_ID`.

```bash
docker build -t <registry>/studio-assembler:<tag> .
```

## Local

```bash
python3 handler.py --local '{"preset":"preview-480p","clips":[{"url":"file:///tmp/a.mp4","in_s":0,"out_s":3}],"output":{"key":"test/out.mp4"}}'
```

`file://` URLs are accepted for local clips. Tests:
`python3 -m pytest workers/assembler` (needs ffmpeg/ffprobe on PATH).
