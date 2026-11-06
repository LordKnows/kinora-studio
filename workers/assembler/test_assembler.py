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


def test_repeat_plays_a_loop_clip_n_times(tmp_path):
    """A 2 s loop with repeat 3 becomes 6 s of picture and sound."""
    a = make_clip(tmp_path / "loop.mp4", seconds=2.0)
    uploader = FakeUploader()
    params = h.validate_input({
        "export_job_id": "exp_loop", "preset": "preview-480p", "video_size": "854x480",
        "clips": [{"url": a.as_uri(), "in_s": 0, "out_s": 2.0, "transition_in": "cut", "repeat": 3}],
        "audio": {"keep_clip_audio": True, "mix_db": {"dialogue": 0, "sfx": 0, "music": -12}, "music_duck_under_dialogue": False},
        "subtitles": {"srt": "", "burn_in": False},
        "output": {"key": "exports/loop.mp4"},
    })
    (tmp_path / "work").mkdir()
    out = h.assemble(params, tmp_path / "work", uploader)
    assert abs(out["duration_s"] - 6.0) < 0.3


def test_speed_mute_and_bt709_tags(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 3.0)
    b = make_clip(tmp_path / "b.mp4", 3.0, freq=880)
    p = h.validate_input(raw_input([
        {"url": f"file://{a}", "in_s": 0, "out_s": 2.0, "speed": 2.0},
        {"url": f"file://{b}", "in_s": 0, "out_s": 2.0, "mute": True},
    ]))
    assert p.clips[0].speed == 2.0 and p.clips[1].mute
    up = FakeUploader()
    out = h.assemble(p, tmp_path, up)
    # 2 s at double speed is 1 s, plus 2 s
    assert abs(out["duration_s"] - 3.0) < 0.25
    assert out["cuts_s"] and abs(out["cuts_s"][0] - 1.0) < 0.1
    assert out["cut_sheet_url"] and out["cut_sheet_url"].endswith(".cuts.png")
    video = tmp_path / "check.mp4"
    video.write_bytes(up.files[p.output_key][0])
    tags = subprocess.run([h.FFPROBE, "-v", "error", "-select_streams", "v", "-show_entries", "stream=color_space,color_primaries,color_transfer", "-of", "csv=p=0", str(video)], capture_output=True, text=True, check=True).stdout.strip()
    assert tags == "bt709,bt709,bt709"
    with pytest.raises(h.JobError, match="speed"):
        h.validate_input(raw_input([{"url": "x", "out_s": 1, "speed": 3}]))


def test_untagged_source_is_read_as_bt601():
    assert h.source_matrix(None) == "bt601-6-525"
    assert h.source_matrix("bt709") == "bt709"
    assert h.color_filter("bt709").startswith("setparams")
    assert "iall=bt601" in h.color_filter(None)
