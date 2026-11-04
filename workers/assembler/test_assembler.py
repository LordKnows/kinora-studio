import subprocess
from pathlib import Path

import pytest

import handler_assembler as h


def make_clip(path: Path, seconds: float, audio: bool = True, size: str = "320x180", freq: int = 440) -> Path:
    args = [h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"smptebars=size={size}:rate=24:duration={seconds}"]
    if audio:
        args += ["-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p"]
    if audio:
        args += ["-c:a", "aac"]
    args += ["-shortest", str(path)]
    subprocess.run(args, check=True)
    return path


class FakeUploader:
    def __init__(self):
        self.files = {}

    def upload(self, path, key, content_type):
        self.files[key] = (Path(path).read_bytes(), content_type)
        return f"https://cdn/{key}"


def raw_input(clips, **over):
    base = {
        "export_job_id": "exp_1", "preset": "master-768p", "video_size": "320x180",
        "clips": clips, "audio": {"keep_clip_audio": True, "mix_db": {"dialogue": 0, "sfx": -3, "music": -12}, "music_duck_under_dialogue": True},
        "subtitles": {"srt": "1\n00:00:00,000 --> 00:00:01,500\nMara: Not tonight.\n", "burn_in": False},
        "output": {"key": "projects/p/exports/exp_1.master-768p.mp4"},
    }
    base.update(over)
    return base


def test_validate_rejects_bad_input():
    with pytest.raises(h.JobError, match="clips must be"):
        h.validate_input(raw_input([]))
    with pytest.raises(h.JobError, match="out_s must be greater"):
        h.validate_input(raw_input([{"url": "x", "in_s": 2, "out_s": 1}]))
    with pytest.raises(h.JobError, match="preset must be"):
        h.validate_input(raw_input([{"url": "x", "out_s": 1}], preset="imax"))
    p = h.validate_input(raw_input([{"url": "x", "out_s": 1, "transition_in": "dissolve"}], preset="social-9x16"))
    assert (p.width, p.height) == (768, 1344) and p.clips[0].transition_in == "cut"


def test_cuts_only_concat_sums_trimmed_lengths(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 3.0)
    b = make_clip(tmp_path / "b.mp4", 2.0, audio=False, size="640x360")
    c = make_clip(tmp_path / "c.mp4", 4.0, freq=880)
    p = h.validate_input(raw_input([
        {"url": f"file://{a}", "in_s": 0.5, "out_s": 2.5},
        {"url": f"file://{b}", "in_s": 0, "out_s": 2.0},
        {"url": f"file://{c}", "in_s": 1.0, "out_s": 3.0},
    ]))
    up = FakeUploader()
    (tmp_path / "w").mkdir()
    out = h.assemble(p, tmp_path / "w", up)
    assert out["url"] == "https://cdn/projects/p/exports/exp_1.master-768p.mp4"
    assert out["srt_url"].endswith("exp_1.master-768p.srt")
    assert abs(out["duration_s"] - 6.0) < 0.3
    assert out["size_bytes"] > 0
    video, _ = up.files["projects/p/exports/exp_1.master-768p.mp4"]
    result = tmp_path / "result.mp4"
    result.write_bytes(video)
    info = h.probe(result)
    assert sorted(info["codecs"]) == ["audio", "video"]
    srt, ctype = up.files["projects/p/exports/exp_1.master-768p.srt"]
    assert b"Mara: Not tonight." in srt and ctype == "application/x-subrip"


def test_dissolve_shortens_by_transition_and_music_mixes(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 3.0)
    b = make_clip(tmp_path / "b.mp4", 3.0, freq=880)
    music = make_clip(tmp_path / "music.mp4", 1.0, freq=220)  # short, gets looped
    p = h.validate_input(raw_input(
        [{"url": f"file://{a}", "in_s": 0, "out_s": 3.0}, {"url": f"file://{b}", "in_s": 0, "out_s": 3.0, "transition_in": "dissolve", "transition_s": 0.5}],
        audio={"keep_clip_audio": True, "music_url": f"file://{music}", "mix_db": {"dialogue": 0, "sfx": -3, "music": -10}, "music_duck_under_dialogue": True},
        subtitles={"srt": "1\n00:00:00,000 --> 00:00:01,000\nhello\n", "burn_in": True},
        preset="preview-480p",
    ))
    (tmp_path / "w").mkdir()
    out = h.assemble(p, tmp_path / "w", FakeUploader())
    assert abs(out["duration_s"] - 5.5) < 0.3
    result = tmp_path / "w" / "burned.mp4"
    assert result.exists()
    width = subprocess.run([h.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(result)], capture_output=True, text=True, check=True).stdout.strip()
    assert width == "854,480"


def test_handler_reports_errors_and_health():
    assert "error" in h.handler({"input": {"clips": []}})
    assert h.handler({"input": {"action": "health"}})["ffmpeg"] is True
