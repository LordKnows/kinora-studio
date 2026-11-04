"""RunPod CPU handler that assembles a Studio timeline with ffmpeg.

Input (from `src/studio/backends/assembler.ts`, `AssemblerInput`):
    export_job_id, preset, video_size "WxH",
    clips: [{url, in_s, out_s, transition_in: cut|dissolve, transition_s?}],
    audio: {keep_clip_audio, music_url?, mix_db: {dialogue, sfx, music}, music_duck_under_dialogue},
    subtitles: {srt, burn_in},
    output: {key}

Output: {url, srt_url?, duration_s, size_bytes}

Steps: download → normalise each clip (size, 24 fps, h264/aac, trim) →
concat (cuts) or xfade/acrossfade chain (dissolves) → music bed with ducking →
optional burned-in subtitles → upload to R2.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import requests

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
FPS = 24
AUDIO_RATE = 48000

PRESETS: dict[str, dict[str, Any]] = {
    "master-768p": {"size": None, "video_bitrate": "8M", "audio_bitrate": "192k"},
    # TODO: route through the H3 worker's upscale + RIFE workflow before assembly.
    "master-upscaled": {"size": None, "video_bitrate": "8M", "audio_bitrate": "192k"},
    "social-9x16": {"size": (768, 1344), "video_bitrate": "6M", "audio_bitrate": "160k"},
    "preview-480p": {"size": (854, 480), "video_bitrate": "1500k", "audio_bitrate": "96k"},
}


class JobError(Exception):
    """Input or media problems the caller can act on."""


@dataclass
class Clip:
    url: str
    in_s: float
    out_s: float
    transition_in: str
    transition_s: float
    repeat: int = 1


@dataclass
class Params:
    export_job_id: str
    preset: str
    width: int
    height: int
    video_bitrate: str
    audio_bitrate: str
    clips: list[Clip]
    keep_clip_audio: bool
    music_url: str | None
    mix_db: dict[str, float]
    duck: bool
    srt: str
    burn_in: bool
    output_key: str


# ---------- input ----------


def validate_input(raw: Any) -> Params:
    if not isinstance(raw, dict):
        raise JobError("input must be an object")
    preset = raw.get("preset", "master-768p")
    if preset not in PRESETS:
        raise JobError(f"preset must be one of {', '.join(PRESETS)}")
    size = PRESETS[preset]["size"] or parse_size(raw.get("video_size", "1344x768"))
    clips_raw = raw.get("clips")
    if not isinstance(clips_raw, list) or not clips_raw:
        raise JobError("clips must be a non-empty list")
    clips: list[Clip] = []
    for i, c in enumerate(clips_raw):
        if not isinstance(c, dict) or not isinstance(c.get("url"), str):
            raise JobError(f"clip {i} needs a url")
        in_s = float(c.get("in_s", 0))
        out_s = float(c.get("out_s", 0))
        if out_s <= in_s:
            raise JobError(f"clip {i}: out_s must be greater than in_s")
        transition = c.get("transition_in", "cut")
        if transition not in ("cut", "dissolve"):
            raise JobError(f"clip {i}: transition_in must be cut or dissolve")
        repeat = c.get("repeat", 1)
        if not isinstance(repeat, int) or not 1 <= repeat <= 120:
            raise JobError("clip repeat must be an integer between 1 and 120")
        clips.append(Clip(c["url"], in_s, out_s, transition, float(c.get("transition_s", 0.4)), repeat))
    clips[0].transition_in = "cut"  # nothing to dissolve from
    audio = raw.get("audio") or {}
    mix = {"dialogue": 0.0, "sfx": -3.0, "music": -12.0}
    mix.update({k: float(v) for k, v in (audio.get("mix_db") or {}).items() if k in mix})
    subs = raw.get("subtitles") or {}
    output = raw.get("output") or {}
    key = output.get("key") if isinstance(output, dict) else None
    if not isinstance(key, str) or not key.endswith(".mp4"):
        raise JobError("output.key must end in .mp4")
    return Params(
        export_job_id=str(raw.get("export_job_id", "")),
        preset=preset,
        width=size[0],
        height=size[1],
        video_bitrate=PRESETS[preset]["video_bitrate"],
        audio_bitrate=PRESETS[preset]["audio_bitrate"],
        clips=clips,
        keep_clip_audio=bool(audio.get("keep_clip_audio", True)),
        music_url=audio.get("music_url") or None,
        mix_db=mix,
        duck=bool(audio.get("music_duck_under_dialogue", True)),
        srt=str(subs.get("srt") or ""),
        burn_in=bool(subs.get("burn_in", False)),
        output_key=key,
    )


def parse_size(value: Any) -> tuple[int, int]:
    if not isinstance(value, str) or "x" not in value:
        raise JobError('video_size must look like "1344x768"')
    w, h = value.lower().split("x", 1)
    if not (w.isdigit() and h.isdigit()):
        raise JobError('video_size must look like "1344x768"')
    return int(w), int(h)


# ---------- ffmpeg helpers ----------


def run(args: list[str]) -> None:
    proc = subprocess.run([FFMPEG, "-v", "error", "-y", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        raise JobError(f"ffmpeg failed: {proc.stderr.strip()[-800:]}")


def probe(path: Path) -> dict[str, Any]:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration,size:stream=codec_type", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    return {
        "duration": float(data.get("format", {}).get("duration", 0) or 0),
        "size": int(data.get("format", {}).get("size", 0) or 0),
        "codecs": [s.get("codec_type") for s in data.get("streams", [])],
    }


def download(url: str, dest: Path) -> Path:
    if url.startswith("file://"):
        shutil.copyfile(url[len("file://"):], dest)
        return dest
    with requests.get(url, stream=True, timeout=600) as res:
        res.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(1 << 20):
                fh.write(chunk)
    return dest


def normalize_clip(src: Path, dst: Path, p: Params, clip: Clip) -> float:
    """Trim, scale-and-crop to the preset frame, 24 fps, h264 + aac stereo.
    Clips without an audio stream get silence so every piece concats alike."""
    info = probe(src)
    has_audio = "audio" in info["codecs"]
    vf = f"scale={p.width}:{p.height}:force_original_aspect_ratio=increase,crop={p.width}:{p.height},fps={FPS},setsar=1,format=yuv420p"
    args = ["-ss", f"{clip.in_s:.3f}", "-t", f"{clip.out_s - clip.in_s:.3f}", "-i", str(src)]
    if not has_audio:
        args += ["-f", "lavfi", "-t", f"{clip.out_s - clip.in_s:.3f}", "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
    gain = p.mix_db["dialogue"] if p.keep_clip_audio else -120.0
    af = f"aresample={AUDIO_RATE},aformat=channel_layouts=stereo,volume={gain}dB"
    args += ["-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0", "-vf", vf, "-af", af,
             "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), "-ac", "2",
             "-shortest", str(dst)]
    run(args)
    return probe(dst)["duration"]


def join_clips(parts: list[tuple[Path, float]], clips: list[Clip], dst: Path, p: Params) -> None:
    """Concat demuxer when every join is a cut; an xfade/acrossfade chain otherwise."""
    if all(c.transition_in == "cut" for c in clips):
        listing = dst.with_suffix(".txt")
        listing.write_text("".join(f"file '{path.as_posix()}'\n" for path, _ in parts))
        run(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(dst)])
        return
    inputs: list[str] = []
    for path, _ in parts:
        inputs += ["-i", str(path)]
    filters: list[str] = []
    v_prev, a_prev = "[0:v]", "[0:a]"
    timeline = parts[0][1]
    for i in range(1, len(parts)):
        clip = clips[i]
        v_out, a_out = f"[v{i}]", f"[a{i}]"
        if clip.transition_in == "dissolve":
            d = min(clip.transition_s, parts[i][1] / 2, parts[i - 1][1] / 2)
            offset = max(0.0, timeline - d)
            filters.append(f"{v_prev}[{i}:v]xfade=transition=fade:duration={d:.3f}:offset={offset:.3f}{v_out}")
            filters.append(f"{a_prev}[{i}:a]acrossfade=d={d:.3f}{a_out}")
            timeline = offset + parts[i][1]
        else:
            filters.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0{v_out}")
            filters.append(f"{a_prev}[{i}:a]concat=n=2:v=0:a=1{a_out}")
            timeline += parts[i][1]
        v_prev, a_prev = v_out, a_out
    run([*inputs, "-filter_complex", ";".join(filters), "-map", v_prev, "-map", a_prev,
         "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, "-pix_fmt", "yuv420p", "-r", str(FPS),
         "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), str(dst)])


def add_music(video: Path, music: Path, dst: Path, p: Params, duration: float) -> None:
    """Loop the music under the cut, at mix_db.music, ducked by the clip audio.

    Ducking is a sidechain compressor: the dialogue/sfx track drives the gain
    of the music, so the bed dips whenever the clips carry sound. amix with
    normalize=0 keeps the clip track at unity."""
    music_chain = f"[1:a]aresample={AUDIO_RATE},aformat=channel_layouts=stereo,atrim=0:{duration:.3f},volume={p.mix_db['music']}dB[m]"
    if p.duck:
        chain = f"{music_chain};[m][0:a]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=500[md];[0:a][md]amix=inputs=2:duration=first:normalize=0[a]"
    else:
        chain = f"{music_chain};[0:a][m]amix=inputs=2:duration=first:normalize=0[a]"
    run(["-i", str(video), "-stream_loop", "-1", "-i", str(music), "-filter_complex", chain, "-map", "0:v", "-map", "[a]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", p.audio_bitrate, "-shortest", str(dst)])


def burn_subtitles(video: Path, srt: Path, dst: Path, p: Params) -> None:
    run(["-i", str(video), "-vf", f"subtitles={srt.as_posix()}", "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, "-c:a", "copy", str(dst)])


# ---------- R2 ----------


class R2Uploader:
    def __init__(self, env: dict[str, str] | None = None):
        env = env or os.environ  # type: ignore[assignment]
        import boto3

        self.bucket = env["R2_BUCKET"]
        self.public = env["R2_PUBLIC_BASE_URL"].rstrip("/")
        self.client = boto3.client(
            "s3", endpoint_url=env["R2_ENDPOINT"], aws_access_key_id=env["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"], region_name="auto",
        )

    def upload(self, path: Path, key: str, content_type: str) -> str:
        self.client.upload_file(str(path), self.bucket, key, ExtraArgs={"ContentType": content_type})
        return f"{self.public}/{key}"


# ---------- job ----------


Uploader = Any
Downloader = Callable[[str, Path], Path]


def assemble(p: Params, workdir: Path, uploader: Uploader, downloader: Downloader = download) -> dict[str, Any]:
    started = time.monotonic()
    parts: list[tuple[Path, float]] = []
    joined_clips: list[Clip] = []
    for i, clip in enumerate(p.clips):
        src = downloader(clip.url, workdir / f"src{i}.mp4")
        dst = workdir / f"norm{i}.mp4"
        length = normalize_clip(src, dst, p, clip)
        # A looped clip is the same normalised file placed `repeat` times; only
        # the first copy carries the incoming transition, the rest are cuts.
        for n in range(clip.repeat):
            parts.append((dst, length))
            joined_clips.append(clip if n == 0 else Clip(clip.url, clip.in_s, clip.out_s, "cut", clip.transition_s, 1))

    cut = workdir / "cut.mp4"
    join_clips(parts, joined_clips, cut, p)
    current = cut

    if p.music_url:
        music = downloader(p.music_url, workdir / "music.bin")
        with_music = workdir / "music.mp4"
        add_music(current, music, with_music, p, probe(current)["duration"])
        current = with_music

    srt_path: Path | None = None
    if p.srt.strip():
        srt_path = workdir / "subs.srt"
        srt_path.write_text(p.srt, encoding="utf-8")
        if p.burn_in:
            burned = workdir / "burned.mp4"
            burn_subtitles(current, srt_path, burned, p)
            current = burned

    info = probe(current)
    url = uploader.upload(current, p.output_key, "video/mp4")
    srt_url = uploader.upload(srt_path, p.output_key[: -len(".mp4")] + ".srt", "application/x-subrip") if srt_path else None
    return {
        "url": url,
        "srt_url": srt_url,
        "duration_s": round(info["duration"], 3),
        "size_bytes": info["size"],
        "execution_ms": int((time.monotonic() - started) * 1000),
        "export_job_id": p.export_job_id,
    }


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """RunPod entry point. Returning {"error": ...} marks the job FAILED."""
    raw = event.get("input") or {}
    if raw.get("action") == "health":
        return {"ok": True, "ffmpeg": shutil.which(FFMPEG) is not None}
    try:
        params = validate_input(raw)
        with tempfile.TemporaryDirectory(prefix="asm-") as tmp:
            return assemble(params, Path(tmp), R2Uploader())
    except JobError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "--local":
        print(json.dumps(handler({"input": json.loads(argv[1])}), indent=2))
        return 0
    import runpod

    runpod.serverless.start({"handler": handler})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
