# assembler — timeline → file on RunPod CPU Serverless

Takes the `AssemblerInput` the Studio builds from a timeline, cuts it with
ffmpeg (transitions, J/L cuts, freezes), mixes narration and a music bed,
levels the loudness, draws titles and subtitles, measures the finished file,
uploads to R2 and returns `{url, srt_url, cut_sheet_url, cuts_s, duration_s,
size_bytes, checks, warnings}`. RunPod posts that to the Studio's signed
`/api/assembler/hook`.

## Input

```json
{
  "export_job_id": "exp_1", "preset": "master-768p", "video_size": "1344x768",
  "clips": [
    {"url": "https://r2/.../take1.mp4", "in_s": 0, "out_s": 8, "transition_in": "cut"},
    {"url": "https://r2/.../take7.mp4", "in_s": 0.5, "out_s": 6, "transition_in": "dissolve", "transition_s": 0.4, "audio_lead_s": 0.5, "freeze_s": 2}
  ],
  "audio": {"keep_clip_audio": true, "music_url": "https://r2/.../music.mp3", "mix_db": {"dialogue": 0, "sfx": -3, "music": -12}, "music_duck_under_dialogue": true,
            "narration": [{"url": "https://r2/.../line.wav", "at_s": 9, "gain_db": 0}], "silences": [{"at_s": 7.5, "duration_s": 0.5}], "loudness_lufs": -14},
  "picture": {"fade_in_s": 0.5, "fade_out_s": 1, "titles": [{"text": "一路颠沛流离，\n却已英雄迟暮", "at_s": 12, "duration_s": 3, "kind": "card"}]},
  "subtitles": {"srt": "1\n00:00:00,000 --> 00:00:02,000\nMara: Not tonight.\n", "burn_in": false},
  "output": {"key": "projects/p1/exports/exp_1.master-768p.mp4"}
}
```

Presets: `master-768p` (the given `video_size`), `master-upscaled` (same for
now; the GPU upscale hop is a TODO in `handler.py`), `social-9x16`
(scale-and-crop to 768×1344), `preview-480p` (854×480, low bitrate).

## How it cuts

1. Each clip is trimmed (`in_s`/`out_s`), retimed (`speed`), scaled and
   centre-cropped to the frame, conformed to 24 fps, h264 + aac 48 kHz stereo,
   BT.709. Clips with no audio get silence. `freeze_s` holds the last frame, in
   silence (a looped clip freezes once, after its last repeat).
   `mix_db.dialogue` is applied to the clip track (dialogue and sfx share that
   track; `mix_db.sfx` is accepted but unused until stems exist).
2. All-cut timelines use the concat demuxer (no re-encode). Any other
   `transition_in` (`dissolve`, `fade_black`, `fade_white`, `iris`, `wipe`)
   switches to an `xfade` + `acrossfade` chain; each one shortens the total by
   its duration.
3. J-cut and L-cut: when a clip has `audio_lead_s` or `audio_trail_s`, the
   clips' sound is relaid. Each part's sound is placed at its own time, the
   leading and trailing ones taken from the source before `in_s` and after
   `out_s`, faded over the lead or trail, and mixed. A take with no footage
   there gives what it has; `warnings` says how much.
4. `audio.narration` lines are mixed onto the clip track at `at_s`, so the
   music ducks under them too.
5. Music loops under the cut at `mix_db.music`, ducked by a sidechain
   compressor keyed on the clip audio when `music_duck_under_dialogue`.
6. `audio.silences` take the whole mix to zero; `audio.loudness_lufs` is a
   two-pass `loudnorm` to that level (true peak -1.5 dB), skipped for a silent
   film and when absent.
7. One picture pass for `picture.fade_in_s` / `fade_out_s` (sound fades with
   it), `picture.titles` and burned-in subtitles. A title is a `card` (covers
   the picture), an `overlay` or a `caption`; its text reaches ffmpeg through a
   file, its colours are checked, and each line is drawn on its own so a block
   is centred. The font is `ASSEMBLER_FONT`, else the first of Noto Sans CJK,
   WenQuanYi, DejaVu that exists, else `fc-match`; with none, titles are left
   out and `warnings` says so.
8. The SRT is uploaded next to the mp4 as `.srt`.
9. The finished file is measured, never judged: `checks.lufs`,
   `checks.true_peak_db`, `checks.black` (ranges of black picture) and
   `checks.silent` (ranges without sound). The Studio reads them against the
   timeline. A cut sheet (3 frames each side of every cut) goes up as
   `.cuts.png`.

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
