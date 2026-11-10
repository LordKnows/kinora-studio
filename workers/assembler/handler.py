"""RunPod CPU handler that assembles a Studio timeline with ffmpeg.

Input (from `src/studio/backends/assembler.ts`, `AssemblerInput`):
    export_job_id, preset, video_size "WxH",
    clips: [{url, in_s, out_s, transition_in: cut|dissolve|fade_black|fade_white|iris|wipe,
             transition_s?, repeat?, speed?, mute?, audio_lead_s?, audio_trail_s?, freeze_s?}],
    audio: {keep_clip_audio, music_url?, mix_db: {dialogue, sfx, music}, music_duck_under_dialogue,
            narration?: [{url, at_s, gain_db?}], silences?: [{at_s, duration_s}], loudness_lufs?},
    picture?: {fade_in_s?, fade_out_s?, titles?: [{text, at_s, duration_s, kind: card|overlay|caption,
               position?, color?, background?, size?}]},
    subtitles: {srt, burn_in},
    output: {key}

Output: {url, srt_url?, cut_sheet_url?, cuts_s, duration_s, size_bytes, checks, warnings}

Steps: download → normalise each clip (size, 24 fps, h264/aac, trim, retime,
freeze, BT.709 colour) → concat (cuts) or an xfade chain (the other
transitions) → the clips' sound relaid when a clip leads or trails its
picture (J-cut, L-cut) → narration → music bed with ducking → silences and
loudness → fades, titles and burned-in subtitles → checks on the finished
file (loudness, black frames, silent stretches) → upload to R2.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Callable

import requests

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
FPS = 24
AUDIO_RATE = 48000
# Colour: every output is BT.709 and says so. A source without colour tags is
# read with this matrix — PyAV/swscale encode RGB → YUV with BT.601 unless told
# otherwise, so untagged H3 takes are BT.601 data. Override with bt709 if an
# ffprobe of a take shows the pod already writes BT.709 without tagging it.
UNTAGGED_MATRIX = os.environ.get("ASSEMBLER_UNTAGGED_MATRIX", "bt601")
OUT_COLOR = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]

PRESETS: dict[str, dict[str, Any]] = {
    "master-768p": {"size": None, "video_bitrate": "8M", "audio_bitrate": "192k"},
    # Uses each take's Open-H3-Regenerate file when it has one. No whole-clip
    # frame interpolation: it smears motion and invents in-betweens on AI video.
    "master-upscaled": {"size": None, "video_bitrate": "8M", "audio_bitrate": "192k"},
    "social-9x16": {"size": (768, 1344), "video_bitrate": "6M", "audio_bitrate": "160k"},
    "preview-480p": {"size": (854, 480), "video_bitrate": "1500k", "audio_bitrate": "96k"},
}


# Every transition but a cut is an xfade between the two pictures.
XFADE = {"dissolve": "fade", "fade_black": "fadeblack", "fade_white": "fadewhite", "iris": "circleopen", "wipe": "wiperight"}
TITLE_KINDS = ("card", "overlay", "caption")
# Where a title sits: (horizontal: l, c, r; vertical: a fraction of the height
# from the top, a negative one from the bottom, or "c" for the middle).
TITLE_POSITIONS: dict[str, tuple[str, float | str]] = {
    "center": ("c", "c"),
    "top": ("c", 0.08),
    "bottom": ("c", -0.12),
    "top_left": ("l", 0.06),
    "top_right": ("r", 0.06),
    "bottom_left": ("l", -0.07),
    "bottom_right": ("r", -0.07),
}
TITLE_X = {"l": "w*0.05", "c": "(w-text_w)/2", "r": "w*0.95-text_w"}
COLOR_RE = re.compile(r"^[A-Za-z0-9#@.]{1,32}$")
# The model draws no text, so titles are drawn here. The first font that
# exists wins; a CJK one comes first because the films are mostly Chinese.
FONT_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]")


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
    speed: float = 1.0
    mute: bool = False
    # J-cut: the clip's sound starts this long before its picture. L-cut: it
    # runs this long after. Both in timeline seconds, both need footage
    # outside the in and out points to take the sound from.
    audio_lead_s: float = 0.0
    audio_trail_s: float = 0.0
    # Hold the last frame this long (a freeze), in silence.
    freeze_s: float = 0.0


@dataclass
class Title:
    text: str
    at_s: float
    duration_s: float
    kind: str = "overlay"
    position: str | None = None
    color: str = "white"
    background: str | None = None
    size: int | None = None


@dataclass
class Narration:
    url: str
    at_s: float
    gain_db: float = 0.0


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
    narration: list[Narration] = field(default_factory=list)
    silences: list[tuple[float, float]] = field(default_factory=list)
    # None leaves the mix as it is; a number is the integrated loudness to land on.
    loudness_lufs: float | None = None
    fade_in_s: float = 0.0
    fade_out_s: float = 0.0
    titles: list[Title] = field(default_factory=list)


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
        if transition != "cut" and transition not in XFADE:
            raise JobError(f"clip {i}: transition_in must be one of cut, {', '.join(XFADE)}")
        repeat = c.get("repeat", 1)
        if not isinstance(repeat, int) or not 1 <= repeat <= 120:
            raise JobError("clip repeat must be an integer between 1 and 120")
        speed = float(c.get("speed", 1.0))
        if not 0.5 <= speed <= 2.0:
            raise JobError("clip speed must be between 0.5 and 2")
        lead, trail, freeze = (bounded(c.get(k, 0), 0, hi, f"clip {i}: {k}") for k, hi in (("audio_lead_s", 2), ("audio_trail_s", 2), ("freeze_s", 10)))
        clips.append(Clip(c["url"], in_s, out_s, transition, float(c.get("transition_s", 0.4)), repeat, speed, bool(c.get("mute", False)), lead, trail, freeze))
    clips[0].transition_in = "cut"  # nothing to dissolve from
    audio = raw.get("audio") or {}
    mix = {"dialogue": 0.0, "sfx": -3.0, "music": -12.0}
    mix.update({k: float(v) for k, v in (audio.get("mix_db") or {}).items() if k in mix})
    narration: list[Narration] = []
    for i, n in enumerate(audio.get("narration") or []):
        if not isinstance(n, dict) or not isinstance(n.get("url"), str):
            raise JobError(f"narration {i} needs a url")
        narration.append(Narration(n["url"], bounded(n.get("at_s", 0), 0, 36000, f"narration {i}: at_s"), bounded(n.get("gain_db", 0), -60, 24, f"narration {i}: gain_db")))
    silences: list[tuple[float, float]] = []
    for i, sil in enumerate(audio.get("silences") or []):
        if not isinstance(sil, dict):
            raise JobError(f"silence {i} must be an object")
        at = bounded(sil.get("at_s", 0), 0, 36000, f"silence {i}: at_s")
        silences.append((at, at + bounded(sil.get("duration_s", 0), 0.05, 60, f"silence {i}: duration_s")))
    loudness = audio.get("loudness_lufs")
    if loudness is not None:
        loudness = bounded(loudness, -30, -8, "loudness_lufs")
    picture = raw.get("picture") or {}
    titles: list[Title] = []
    for i, t in enumerate(picture.get("titles") or []):
        if not isinstance(t, dict) or not isinstance(t.get("text"), str) or not t["text"].strip():
            raise JobError(f"title {i} needs text")
        kind = t.get("kind", "overlay")
        if kind not in TITLE_KINDS:
            raise JobError(f"title {i}: kind must be one of {', '.join(TITLE_KINDS)}")
        position = t.get("position")
        if position is not None and position not in TITLE_POSITIONS:
            raise JobError(f"title {i}: position must be one of {', '.join(TITLE_POSITIONS)}")
        for key in ("color", "background"):
            if t.get(key) is not None and not (isinstance(t[key], str) and COLOR_RE.match(t[key])):
                raise JobError(f"title {i}: {key} must be a colour name or #RRGGBB, with an optional @opacity")
        font_size = t.get("size")
        if font_size is not None and not (isinstance(font_size, int) and 8 <= font_size <= 400):
            raise JobError(f"title {i}: size must be an integer between 8 and 400")
        titles.append(Title(
            t["text"][:500], bounded(t.get("at_s", 0), 0, 36000, f"title {i}: at_s"), bounded(t.get("duration_s", 3), 0.2, 600, f"title {i}: duration_s"),
            kind, position, t.get("color") or "white", t.get("background"), font_size,
        ))
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
        narration=narration,
        silences=silences,
        loudness_lufs=loudness,
        fade_in_s=bounded(picture.get("fade_in_s", 0), 0, 5, "fade_in_s"),
        fade_out_s=bounded(picture.get("fade_out_s", 0), 0, 5, "fade_out_s"),
        titles=titles,
    )


def bounded(value: Any, lo: float, hi: float, what: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise JobError(f"{what} must be a number") from None
    if not lo <= number <= hi:
        raise JobError(f"{what} must be between {lo:g} and {hi:g}")
    return number


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
        [FFPROBE, "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,color_space,color_primaries,color_transfer", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    data = json.loads(out)
    video = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    return {
        "duration": float(data.get("format", {}).get("duration", 0) or 0),
        "size": int(data.get("format", {}).get("size", 0) or 0),
        "codecs": [s.get("codec_type") for s in data.get("streams", [])],
        "color_space": video.get("color_space"),
    }


def source_matrix(color_space: str | None) -> str:
    """The matrix a clip's YUV was written with, for the colorspace filter."""
    if color_space in ("bt709",):
        return "bt709"
    if color_space in ("bt470bg", "smpte170m", "bt601"):
        return "bt601-6-625" if color_space == "bt470bg" else "bt601-6-525"
    return "bt601-6-525" if UNTAGGED_MATRIX == "bt601" else "bt709"


def color_filter(color_space: str | None) -> str:
    """Convert to BT.709 when the source is not; tag the frames either way."""
    src = source_matrix(color_space)
    if src == "bt709":
        return "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709"
    return f"colorspace=all=bt709:iall={src}:fast=1"


def atempo_chain(speed: float) -> str:
    return f"atempo={speed:.4f}" if 0.5 <= speed <= 2.0 else "atempo=1"


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
    """Trim, retime, scale-and-crop to the preset frame, 24 fps, BT.709,
    h264 + aac stereo. Clips without an audio stream (or muted ones) get
    silence so every piece concats alike. A freeze holds the last frame, in
    silence."""
    info = probe(src)
    has_audio = "audio" in info["codecs"] and not clip.mute
    span = clip.out_s - clip.in_s
    out_len = span / clip.speed + clip.freeze_s
    retime = f",setpts=PTS/{clip.speed:.4f}" if abs(clip.speed - 1) > 1e-3 else ""
    hold = f",tpad=stop_mode=clone:stop_duration={clip.freeze_s:.3f}" if clip.freeze_s > 0 else ""
    vf = f"{color_filter(info.get('color_space'))}{retime},scale={p.width}:{p.height}:force_original_aspect_ratio=increase,crop={p.width}:{p.height},fps={FPS}{hold},setsar=1,format=yuv420p"
    args = ["-ss", f"{clip.in_s:.3f}", "-t", f"{span:.3f}", "-i", str(src)]
    if not has_audio:
        args += ["-f", "lavfi", "-t", f"{out_len:.3f}", "-i", f"anullsrc=r={AUDIO_RATE}:cl=stereo"]
    af = clip_audio_filter(p, clip, has_audio) + (f",apad=pad_dur={clip.freeze_s:.3f}" if clip.freeze_s > 0 and has_audio else "")
    args += ["-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0", "-vf", vf, "-af", af,
             "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, *OUT_COLOR, "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), "-ac", "2",
             "-shortest", str(dst)]
    run(args)
    return probe(dst)["duration"]


def clip_audio_filter(p: Params, clip: Clip, has_audio: bool) -> str:
    """Resample, retime and set the level of a clip's own sound."""
    gain = p.mix_db["dialogue"] if p.keep_clip_audio else -120.0
    tempo = f",{atempo_chain(clip.speed)}" if has_audio and abs(clip.speed - 1) > 1e-3 else ""
    return f"aresample={AUDIO_RATE},aformat=channel_layouts=stereo{tempo},volume={gain}dB"


def overlap(parts: list[tuple[Path, float]], clips: list[Clip], i: int) -> float:
    """How long part i shares the screen with the part before it."""
    if i <= 0 or i >= len(parts) or clips[i].transition_in == "cut":
        return 0.0
    return min(clips[i].transition_s, parts[i][1] / 2, parts[i - 1][1] / 2)


def layout(parts: list[tuple[Path, float]], clips: list[Clip]) -> tuple[list[float], float]:
    """Where every part starts on the assembled picture, and how long the picture is."""
    starts = [0.0]
    end = parts[0][1] if parts else 0.0
    for i in range(1, len(parts)):
        start = max(0.0, end - overlap(parts, clips, i))
        starts.append(start)
        end = start + parts[i][1]
    return starts, end


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
        if clip.transition_in != "cut":
            d = overlap(parts, clips, i)
            offset = max(0.0, timeline - d)
            filters.append(f"{v_prev}[{i}:v]xfade=transition={XFADE[clip.transition_in]}:duration={d:.3f}:offset={offset:.3f}{v_out}")
            filters.append(f"{a_prev}[{i}:a]acrossfade=d={d:.3f}{a_out}")
            timeline = offset + parts[i][1]
        else:
            filters.append(f"{v_prev}[{i}:v]concat=n=2:v=1:a=0{v_out}")
            filters.append(f"{a_prev}[{i}:a]concat=n=2:v=0:a=1{a_out}")
            timeline += parts[i][1]
        v_prev, a_prev = v_out, a_out
    run([*inputs, "-filter_complex", ";".join(filters), "-map", v_prev, "-map", a_prev,
         "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, "-pix_fmt", "yuv420p", *OUT_COLOR, "-r", str(FPS),
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


# ---------- sound that leads or trails its picture ----------


def extended_audio(src: Path, dst: Path, p: Params, clip: Clip, lead: float, trail: float, src_duration: float) -> tuple[float, float]:
    """The clip's sound with up to `lead` seconds before its in point and
    `trail` after its out point (timeline seconds). Returns what the footage
    really had: a take that starts at its in point has nothing to lead with."""
    lead_src = min(lead * clip.speed, clip.in_s)
    trail_src = max(0.0, min(trail * clip.speed, src_duration - clip.out_s))
    start = clip.in_s - lead_src
    span = clip.out_s + trail_src - start
    run(["-ss", f"{start:.3f}", "-t", f"{span:.3f}", "-i", str(src), "-vn", "-af", clip_audio_filter(p, clip, True),
         "-c:a", "pcm_s16le", "-ar", str(AUDIO_RATE), "-ac", "2", str(dst)])
    return lead_src / clip.speed, trail_src / clip.speed


def relay_audio(video: Path, entries: list[tuple[Path, float, float, float, float]], total: float, dst: Path, p: Params) -> None:
    """Lay every part's sound at its own time and mix. entries: (file, at_s,
    fade_in_s, fade_out_s, length_s). Overlapping fades are the crossfade."""
    inputs: list[str] = ["-i", str(video)]
    filters: list[str] = []
    labels: list[str] = []
    for k, (path, at, fade_in, fade_out, length) in enumerate(entries):
        inputs += ["-i", str(path)]
        chain = f"[{k + 1}:a]aresample={AUDIO_RATE},aformat=channel_layouts=stereo"
        if fade_in > 0.005:
            chain += f",afade=t=in:st=0:d={fade_in:.3f}"
        if fade_out > 0.005:
            chain += f",afade=t=out:st={max(0.0, length - fade_out):.3f}:d={fade_out:.3f}"
        ms = int(round(max(0.0, at) * 1000))
        filters.append(f"{chain},adelay={ms}|{ms}[b{k}]")
        labels.append(f"[b{k}]")
    filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0,atrim=0:{total:.3f},apad=whole_dur={total:.3f}[a]")
    run([*inputs, "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[a]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), "-t", f"{total:.3f}", str(dst)])


def add_narration(video: Path, lines: list[tuple[Path, Narration]], dst: Path, p: Params) -> None:
    """Narration sits on the clip track, so the music ducks under it too."""
    inputs: list[str] = ["-i", str(video)]
    filters: list[str] = []
    labels: list[str] = []
    for k, (path, line) in enumerate(lines):
        inputs += ["-i", str(path)]
        ms = int(round(line.at_s * 1000))
        filters.append(f"[{k + 1}:a]aresample={AUDIO_RATE},aformat=channel_layouts=stereo,volume={line.gain_db + p.mix_db['dialogue']:.2f}dB,adelay={ms}|{ms}[n{k}]")
        labels.append(f"[n{k}]")
    filters.append(f"[0:a]{''.join(labels)}amix=inputs={len(labels) + 1}:duration=first:normalize=0[a]")
    run([*inputs, "-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[a]",
         "-c:v", "copy", "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), str(dst)])


# ---------- loudness ----------

LOUDNORM_TP = -1.5
LOUDNORM_LRA = 11


def measure_loudnorm(video: Path, pre: list[str], target: float) -> dict[str, str] | None:
    """First pass of a two-pass loudnorm. None when the mix is silent."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", str(video), "-vn",
         "-af", ",".join([*pre, f"loudnorm=I={target}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:print_format=json"]), "-f", "null", "-"],
        capture_output=True, text=True,
    )
    start, end = proc.stderr.rfind("{"), proc.stderr.rfind("}")
    if proc.returncode != 0 or start < 0 or end < start:
        raise JobError(f"loudness measurement failed: {proc.stderr.strip()[-300:]}")
    measured = json.loads(proc.stderr[start:end + 1])
    try:
        level = float(measured["input_i"])
    except (KeyError, ValueError):
        return None
    return measured if level > -70 else None


def finish_audio(video: Path, dst: Path, p: Params) -> bool:
    """Silences (the whole bus out) and the loudness target. False when there was nothing to do."""
    pre = [f"volume=volume=0:enable='between(t,{a:.3f},{b:.3f})'" for a, b in p.silences]
    chain = list(pre)
    if p.loudness_lufs is not None:
        m = measure_loudnorm(video, pre, p.loudness_lufs)
        if m:
            chain.append(
                f"loudnorm=I={p.loudness_lufs}:TP={LOUDNORM_TP}:LRA={LOUDNORM_LRA}:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
                f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true"
            )
            # loudnorm works at 192 kHz; a second pass of silence keeps the gaps at zero after it.
            chain += [f"aresample={AUDIO_RATE}", *pre]
    if not chain:
        return False
    run(["-i", str(video), "-af", ",".join(chain), "-c:v", "copy", "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE), str(dst)])
    return True


# ---------- fades, titles, burned subtitles ----------


def find_font() -> str | None:
    for path in [os.environ.get("ASSEMBLER_FONT"), *FONT_CANDIDATES]:
        if path and Path(path).is_file():
            return path
    if shutil.which("fc-match"):
        for pattern in ("sans:lang=zh", "sans"):
            found = subprocess.run(["fc-match", "-f", "%{file}", pattern], capture_output=True, text=True).stdout.strip()
            if found and Path(found).is_file():
                return found
    return None


def title_filters(p: Params, font: str, workdir: Path) -> list[str]:
    """A card covers the picture; an overlay and a caption sit on it. Each
    line is drawn on its own so a block of lines is centred line by line. The
    text goes through files, so nothing in it is read as filter syntax."""
    out: list[str] = []
    for k, t in enumerate(p.titles):
        enable = f"enable='between(t,{t.at_s:.3f},{t.at_s + t.duration_s:.3f})'"
        size = t.size or round(p.height / {"card": 11, "overlay": 14, "caption": 22}[t.kind])
        across, down = TITLE_POSITIONS[t.position or ("bottom" if t.kind == "caption" else "center")]
        if t.kind == "card":
            out.append(f"drawbox=x=0:y=0:w=iw:h=ih:color={t.background or 'black'}:t=fill:{enable}")
            dress = ""
        elif t.background:
            dress = f":box=1:boxcolor={t.background}:boxborderw={max(4, size // 3)}"
        else:
            dress = ":borderw=2:bordercolor=black@0.6"
        lines = t.text.replace("\r", "").split("\n")[:12]
        line_h = round(size * 1.4)
        block = line_h * len(lines)
        top = f"(h-{block})/2" if down == "c" else f"h*{down}" if down >= 0 else f"h*{1 + down:.3f}-{block}"  # type: ignore[operator]
        for n, line in enumerate(lines):
            if not line.strip():
                continue
            text_file = workdir / f"title{k}_{n}.txt"
            text_file.write_text(line, encoding="utf-8")
            out.append(
                f"drawtext=fontfile='{font}':textfile='{text_file.as_posix()}':fontsize={size}:fontcolor={t.color}"
                f":x={TITLE_X[across]}:y={top}+{n * line_h}{dress}:{enable}"
            )
    return out


def finish_picture(video: Path, dst: Path, p: Params, duration: float, srt: Path | None, workdir: Path) -> list[str]:
    """Fade in and out (picture and sound), titles, burned-in subtitles: one
    encode. Returns what it had to leave out."""
    warnings: list[str] = []
    vf: list[str] = []
    af: list[str] = []
    if p.fade_in_s > 0:
        vf.append(f"fade=t=in:st=0:d={p.fade_in_s:.3f}")
        af.append(f"afade=t=in:st=0:d={p.fade_in_s:.3f}")
    if p.fade_out_s > 0:
        start = max(0.0, duration - p.fade_out_s)
        vf.append(f"fade=t=out:st={start:.3f}:d={p.fade_out_s:.3f}")
        af.append(f"afade=t=out:st={start:.3f}:d={p.fade_out_s:.3f}")
    if p.titles:
        font = find_font()
        if not font:
            warnings.append(f"{len(p.titles)} title(s) left out: no font on the assembler (set ASSEMBLER_FONT)")
        else:
            if any(CJK_RE.search(t.text) for t in p.titles) and not re.search(r"cjk|wqy|han|noto.*s[ck]", font, re.I):
                warnings.append(f"titles contain Chinese, Japanese or Korean text and the font is {Path(font).name}; they may show as boxes")
            vf += title_filters(p, font, workdir)
    if srt is not None:
        vf.append(f"subtitles={srt.as_posix()}")
    if not vf:
        return warnings
    audio = ["-af", ",".join(af), "-c:a", "aac", "-b:a", p.audio_bitrate, "-ar", str(AUDIO_RATE)] if af else ["-c:a", "copy"]
    run(["-i", str(video), "-vf", ",".join(vf), "-c:v", "libx264", "-preset", "medium", "-b:v", p.video_bitrate, "-pix_fmt", "yuv420p", *OUT_COLOR, *audio, str(dst)])
    return warnings


# ---------- checks on the finished file ----------


def inspect(video: Path, duration: float) -> dict[str, Any]:
    """What a viewer would notice first: how loud it is, where the picture is
    black and where the sound drops out. Measured, never judged, here."""
    proc = subprocess.run(
        [FFMPEG, "-hide_banner", "-nostats", "-i", str(video), "-vf", "blackdetect=d=0.25:pix_th=0.10",
         "-af", "silencedetect=noise=-60dB:d=1,ebur128=peak=true:framelog=verbose", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    log = proc.stderr
    loud = re.findall(r"\bI:\s+(-?[\d.]+) LUFS", log)
    peak = re.findall(r"\bPeak:\s+(-?[\d.]+) dBFS", log)
    black = [[round(float(a), 3), round(float(b), 3)] for a, b in re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", log)]
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", log)]
    ends = [float(x) for x in re.findall(r"silence_end: ([\d.]+)", log)]
    silent = [[round(max(0.0, a), 3), round(ends[i] if i < len(ends) else duration, 3)] for i, a in enumerate(starts)]
    return {
        "lufs": float(loud[-1]) if loud else None,
        "true_peak_db": float(peak[-1]) if peak else None,
        "black": black,
        "silent": silent,
    }


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


def cut_times(parts: list[tuple[Path, float]], clips: list[Clip]) -> list[float]:
    """Where every join lands on the assembled picture (the middle of a transition)."""
    out: list[float] = []
    t = parts[0][1] if parts else 0.0
    for i in range(1, len(parts)):
        clip = clips[i]
        if clip.transition_in != "cut":
            d = overlap(parts, clips, i)
            offset = max(0.0, t - d)
            out.append(round(offset + d / 2, 3))
            t = offset + parts[i][1]
        else:
            out.append(round(t, 3))
            t += parts[i][1]
    return out


def cut_sheet(video: Path, cuts: list[float], dst: Path, width: int = 240) -> bool:
    """One row per cut: the 3 frames before it and the 3 after, for a review
    of jumps and colour breaks at every seam. False when there is nothing to show."""
    if not cuts:
        return False
    picks: list[str] = []
    for c in cuts[:60]:
        n = int(round(c * FPS))
        picks.append(f"between(n,{max(0, n - 3)},{n + 2})")
    vf = f"select='{'+'.join(picks)}',scale={width}:-2,tile=6x{len(picks)}:padding=4:color=black"
    run(["-i", str(video), "-vf", vf, "-frames:v", "1", "-fps_mode", "passthrough", str(dst)])
    return dst.exists()


def assemble(p: Params, workdir: Path, uploader: Uploader, downloader: Downloader = download) -> dict[str, Any]:
    started = time.monotonic()
    warnings: list[str] = []
    parts: list[tuple[Path, float]] = []
    joined_clips: list[Clip] = []
    # Per part: the source it came from and the sound it may lead or trail with.
    sources: list[tuple[Path, Clip, float, float]] = []
    for i, clip in enumerate(p.clips):
        src = downloader(clip.url, workdir / f"src{i}.mp4")
        # A looped clip is the same normalised file placed `repeat` times; only
        # the first copy carries the incoming transition and the lead, only the
        # last one the freeze and the trail.
        plain = replace(clip, freeze_s=0.0) if clip.repeat > 1 and clip.freeze_s > 0 else clip
        dst = workdir / f"norm{i}.mp4"
        length = normalize_clip(src, dst, p, plain)
        last_dst, last_length = dst, length
        if plain is not clip:
            last_dst = workdir / f"norm{i}f.mp4"
            last_length = normalize_clip(src, last_dst, p, clip)
        for n in range(clip.repeat):
            last = n == clip.repeat - 1
            parts.append((last_dst, last_length) if last else (dst, length))
            joined_clips.append(clip if n == 0 else replace(clip, transition_in="cut", repeat=1))
            sources.append((src, clip, clip.audio_lead_s if n == 0 else 0.0, clip.audio_trail_s if last else 0.0))

    cut = workdir / "cut.mp4"
    join_clips(parts, joined_clips, cut, p)
    current = cut
    starts, total = layout(parts, joined_clips)

    if any(lead > 0 or trail > 0 for _, _, lead, trail in sources):
        entries: list[tuple[Path, float, float, float, float]] = []
        for k, (src, clip, lead, trail) in enumerate(sources):
            fade_in, fade_out = overlap(parts, joined_clips, k), overlap(parts, joined_clips, k + 1)
            info = probe(src)
            if (lead > 0 or trail > 0) and "audio" in info["codecs"] and not clip.mute:
                wide = workdir / f"wide{k}.wav"
                got_lead, got_trail = extended_audio(src, wide, p, clip, lead, trail, info["duration"])
                if got_lead + 0.02 < lead or got_trail + 0.02 < trail:
                    warnings.append(
                        f"clip {p.clips.index(clip) + 1}: asked for {lead:g} s of lead and {trail:g} s of trail, the take had {got_lead:.2f} s before its in point and {got_trail:.2f} s after its out point"
                    )
                body = (clip.out_s - clip.in_s) / clip.speed
                entries.append((wide, starts[k] - got_lead, max(got_lead, fade_in), max(got_trail, fade_out), got_lead + body + got_trail))
            else:
                entries.append((parts[k][0], starts[k], fade_in, fade_out, parts[k][1]))
        relaid = workdir / "relaid.mp4"
        relay_audio(current, entries, total, relaid, p)
        current = relaid

    if p.narration:
        lines = [(downloader(line.url, workdir / f"narration{k}.bin"), line) for k, line in enumerate(p.narration)]
        spoken = workdir / "narration.mp4"
        add_narration(current, lines, spoken, p)
        current = spoken

    if p.music_url:
        music = downloader(p.music_url, workdir / "music.bin")
        with_music = workdir / "music.mp4"
        add_music(current, music, with_music, p, probe(current)["duration"])
        current = with_music

    levelled = workdir / "levelled.mp4"
    if finish_audio(current, levelled, p):
        current = levelled

    srt_path: Path | None = None
    if p.srt.strip():
        srt_path = workdir / "subs.srt"
        srt_path.write_text(p.srt, encoding="utf-8")
    burn = srt_path if p.burn_in else None
    finished = workdir / ("burned.mp4" if burn else "finished.mp4")
    warnings += finish_picture(current, finished, p, probe(current)["duration"], burn, workdir)
    if finished.exists():
        current = finished

    info = probe(current)
    checks: dict[str, Any] = {}
    try:
        checks = inspect(current, info["duration"])
    except Exception as err:  # noqa: BLE001 - a missing measurement never fails the export
        print(f"[assembler] checks skipped: {err}", file=sys.stderr)
    url = uploader.upload(current, p.output_key, "video/mp4")
    srt_url = uploader.upload(srt_path, p.output_key[: -len(".mp4")] + ".srt", "application/x-subrip") if srt_path else None
    cuts = cut_times(parts, joined_clips)
    sheet_url = None
    try:
        sheet = workdir / "cuts.png"
        if cut_sheet(current, cuts, sheet):
            sheet_url = uploader.upload(sheet, p.output_key[: -len(".mp4")] + ".cuts.png", "image/png")
    except JobError as err:  # a missing sheet never fails the export
        print(f"[assembler] cut sheet skipped: {err}", file=sys.stderr)
    return {
        "url": url,
        "srt_url": srt_url,
        "cut_sheet_url": sheet_url,
        "cuts_s": cuts,
        "duration_s": round(info["duration"], 3),
        "size_bytes": info["size"],
        "checks": checks,
        "warnings": warnings,
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
