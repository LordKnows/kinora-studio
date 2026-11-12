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


# ---------- the extended timeline: J/L cuts, freeze, transitions, titles, narration, loudness ----------


def level(path: Path, start: float, end: float, freq: int | None = None) -> float:
    """Mean volume in dB of a stretch of the sound, optionally in a narrow band around freq."""
    band = f",bandpass=f={freq}:width_type=h:w=60" if freq else ""
    proc = subprocess.run(
        [h.FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af", f"atrim={start}:{end}{band},volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    found = h.re.search(r"mean_volume: (-?[\d.]+|-inf) dB", proc.stderr)
    assert found, proc.stderr[-400:]
    return float("-inf") if found.group(1) == "-inf" else float(found.group(1))


def export(tmp_path: Path, clips, **over):
    up = FakeUploader()
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    p = h.validate_input(raw_input(clips, **{"subtitles": {"srt": "", "burn_in": False}, **over}))
    out = h.assemble(p, work, up)
    result = tmp_path / "result.mp4"
    result.write_bytes(up.files[p.output_key][0])
    return out, result


def test_validate_extended_fields():
    p = h.validate_input(raw_input(
        [{"url": "x", "out_s": 2}, {"url": "y", "in_s": 1, "out_s": 3, "transition_in": "iris", "audio_lead_s": 0.5, "audio_trail_s": 0.25, "freeze_s": 1}],
        audio={"narration": [{"url": "n", "at_s": 1.5, "gain_db": -3}], "silences": [{"at_s": 2, "duration_s": 1}], "loudness_lufs": -14},
        picture={"fade_in_s": 0.5, "fade_out_s": 1, "titles": [{"text": "一路颠沛流离", "at_s": 0, "duration_s": 3, "kind": "card", "background": "black@0.8"}]},
    ))
    assert p.clips[1].transition_in == "iris" and p.clips[1].audio_lead_s == 0.5 and p.clips[1].freeze_s == 1
    assert p.narration[0].at_s == 1.5 and p.silences == [(2.0, 3.0)] and p.loudness_lufs == -14
    assert p.fade_out_s == 1 and p.titles[0].kind == "card"
    # an old input still means what it meant
    old = h.validate_input(raw_input([{"url": "x", "out_s": 2}]))
    assert old.loudness_lufs is None and not old.titles and not old.narration and old.fade_in_s == 0
    for bad, why in [
        ({"clips": [{"url": "x", "out_s": 1, "transition_in": "star_wipe"}]}, "transition_in"),
        ({"clips": [{"url": "x", "out_s": 1, "audio_lead_s": 3}]}, "audio_lead_s"),
        ({"picture": {"titles": [{"text": "a", "at_s": 0, "duration_s": 1, "color": "red:x=0"}]}}, "colour"),
        ({"picture": {"titles": [{"text": "a", "at_s": 0, "duration_s": 1, "kind": "banner"}]}}, "kind"),
        ({"audio": {"loudness_lufs": 0}}, "loudness_lufs"),
    ]:
        with pytest.raises(h.JobError, match=why):
            h.validate_input(raw_input(bad.pop("clips", [{"url": "x", "out_s": 1}]), **bad))


def test_j_cut_and_l_cut_move_the_sound_not_the_picture(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 4.0, freq=440)
    b = make_clip(tmp_path / "b.mp4", 4.0, freq=880)
    plain = [{"url": f"file://{a}", "in_s": 0, "out_s": 3.0}, {"url": f"file://{b}", "in_s": 1.0, "out_s": 3.0}]
    (tmp_path / "plain").mkdir()
    out0, base = export(tmp_path / "plain", plain)
    jl = [
        {"url": f"file://{a}", "in_s": 0, "out_s": 3.0, "audio_trail_s": 0.6},
        {"url": f"file://{b}", "in_s": 1.0, "out_s": 3.0, "audio_lead_s": 0.8},
    ]
    (tmp_path / "jl").mkdir()
    out1, cut = export(tmp_path / "jl", jl)
    # the picture is as long as before, and the cut is where it was
    assert abs(out1["duration_s"] - out0["duration_s"]) < 0.1 and abs(out1["duration_s"] - 5.0) < 0.3
    assert abs(out1["cuts_s"][0] - 3.0) < 0.1
    assert out1["warnings"] == []
    # J-cut: b's 880 Hz is heard before the cut at 3.0 s
    assert level(cut, 2.5, 2.9, 880) > level(base, 2.5, 2.9, 880) + 20
    # L-cut: a's 440 Hz is still heard after it
    # (it is fading out over the trail, so the margin is smaller)
    assert level(cut, 3.1, 3.4, 440) > level(base, 3.1, 3.4, 440) + 12
    assert level(cut, 3.7, 4.5, 440) < level(cut, 3.1, 3.4, 440) - 10
    # and well inside each clip nothing changed
    assert abs(level(cut, 1.0, 2.0, 440) - level(base, 1.0, 2.0, 440)) < 3


def test_a_lead_the_take_cannot_give_is_reported(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 3.0, freq=440)
    b = make_clip(tmp_path / "b.mp4", 2.0, freq=880)
    out, _ = export(tmp_path, [
        {"url": f"file://{a}", "in_s": 0, "out_s": 3.0, "audio_trail_s": 0.5},  # nothing after 3.0 s
        {"url": f"file://{b}", "in_s": 0, "out_s": 2.0, "audio_lead_s": 0.5},  # nothing before 0 s
    ])
    assert len(out["warnings"]) == 2 and "the take had 0.00 s before its in point" in out["warnings"][1]
    assert abs(out["duration_s"] - 5.0) < 0.3


def test_freeze_holds_the_last_frame_and_loops_freeze_once(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 2.0)
    out, _ = export(tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 2.0, "freeze_s": 1.5}])
    assert abs(out["duration_s"] - 3.5) < 0.2
    (tmp_path / "loop").mkdir()
    out, _ = export(tmp_path / "loop", [{"url": f"file://{a}", "in_s": 0, "out_s": 2.0, "freeze_s": 1.0, "repeat": 3}])
    assert abs(out["duration_s"] - 7.0) < 0.3


@pytest.mark.parametrize("transition", ["fade_black", "fade_white", "iris", "wipe"])
def test_other_transitions_overlap_like_a_dissolve(tmp_path, transition):
    a = make_clip(tmp_path / "a.mp4", 3.0)
    b = make_clip(tmp_path / "b.mp4", 3.0, freq=880)
    out, _ = export(tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 3.0}, {"url": f"file://{b}", "in_s": 0, "out_s": 3.0, "transition_in": transition, "transition_s": 0.5}])
    assert abs(out["duration_s"] - 5.5) < 0.3
    assert abs(out["cuts_s"][0] - 2.75) < 0.1


def luma(path: Path, at: float) -> tuple[float, float]:
    """Average and brightest luma of the frame at a time."""
    proc = subprocess.run(
        [h.FFMPEG, "-hide_banner", "-nostats", "-ss", f"{at}", "-i", str(path), "-frames:v", "1", "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"],
        capture_output=True, text=True, check=True,
    )
    avg = h.re.search(r"signalstats\.YAVG=([\d.]+)", proc.stdout)
    top = h.re.search(r"signalstats\.YMAX=([\d.]+)", proc.stdout)
    assert avg and top, proc.stdout[-300:]
    return float(avg.group(1)), float(top.group(1))


def test_titles_fades_silence_and_loudness(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 6.0)
    out, result = export(
        tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 6.0}],
        audio={"keep_clip_audio": True, "mix_db": {"dialogue": 0, "sfx": -3, "music": -12}, "silences": [{"at_s": 3.5, "duration_s": 1.5}], "loudness_lufs": -14},
        picture={"fade_in_s": 0.5, "fade_out_s": 0.5, "titles": [
            {"text": "一路颠沛流离，却已英雄迟暮", "at_s": 1.0, "duration_s": 1.5, "kind": "card"},
            {"text": "1927", "at_s": 3.0, "duration_s": 2.0, "kind": "caption", "background": "black@0.5"},
            {"text": "REC", "at_s": 3.0, "duration_s": 3, "kind": "overlay", "position": "top_left", "color": "#ff3030", "size": 20},
        ]},
    )
    assert abs(out["duration_s"] - 6.0) < 0.2
    assert out["warnings"] == []
    # the card covers the picture with black and carries lit text; a card with text is not a black frame
    bars_avg, _ = luma(result, 0.8)
    card_avg, card_top = luma(result, 1.7)
    assert bars_avg > 80 and card_avg < 40 and card_top > 180, (bars_avg, card_avg, card_top)
    checks = out["checks"]
    assert checks["black"] == []
    # the fade in starts from black
    assert luma(result, 0.0)[0] < 30
    # the silence is digital zero for its whole length, and the check finds it
    assert any(abs(start - 3.5) < 0.2 and abs(end - 5.0) < 0.2 for start, end in checks["silent"]), checks
    assert level(result, 3.7, 4.8) < -80
    # and the mix lands on the target
    assert checks["lufs"] is not None and abs(checks["lufs"] - (-14)) < 1.5, checks
    assert checks["true_peak_db"] is not None and checks["true_peak_db"] <= -1.0


def test_checks_find_black_frames(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 2.0)
    black = tmp_path / "black.mp4"
    subprocess.run([h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=24:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(black)], check=True)
    out, _ = export(tmp_path, [
        {"url": f"file://{a}", "in_s": 0, "out_s": 2.0},
        {"url": f"file://{black}", "in_s": 0, "out_s": 1.5},
        {"url": f"file://{a}", "in_s": 0, "out_s": 2.0},
    ])
    assert any(abs(start - 2.0) < 0.2 and abs(end - 3.5) < 0.2 for start, end in out["checks"]["black"]), out["checks"]
    # without a loudness target the mix is left as it was, and still measured
    assert out["checks"]["lufs"] is not None


def test_loudness_leaves_a_silent_film_alone(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 3.0, audio=False)
    out, _ = export(tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 3.0}], audio={"keep_clip_audio": True, "loudness_lufs": -14})
    assert abs(out["duration_s"] - 3.0) < 0.2
    assert out["checks"]["silent"] and out["checks"]["silent"][0][0] < 0.1


def test_narration_is_laid_at_its_time_and_ducks_the_music(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 5.0, audio=False)
    voice = tmp_path / "voice.wav"
    subprocess.run([h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1.5", str(voice)], check=True)
    music = make_clip(tmp_path / "music.mp4", 2.0, freq=220)
    out, result = export(
        tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 5.0}],
        audio={"keep_clip_audio": True, "music_url": f"file://{music}", "mix_db": {"dialogue": 0, "sfx": -3, "music": -6},
               "music_duck_under_dialogue": True, "narration": [{"url": f"file://{voice}", "at_s": 2.0}]},
    )
    assert abs(out["duration_s"] - 5.0) < 0.2
    # the voice is where it was put
    assert level(result, 2.2, 3.3, 880) > level(result, 0.5, 1.5, 880) + 25
    # and the music is lower under it than before it
    assert level(result, 2.4, 3.3, 220) < level(result, 0.5, 1.5, 220) - 3


def test_narration_with_text_becomes_a_subtitle_cue_as_long_as_its_audio(tmp_path):
    a = make_clip(tmp_path / "a.mp4", 6.0, audio=False)
    voice = tmp_path / "voice.wav"
    subprocess.run([h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=1.7", str(voice)], check=True)
    out, _ = export(
        tmp_path, [{"url": f"file://{a}", "in_s": 0, "out_s": 6.0}],
        audio={"keep_clip_audio": True, "narration": [
            {"url": f"file://{voice}", "at_s": 3.0, "text": "那一年，河水涨了十二米。"},
            {"url": f"file://{voice}", "at_s": 5.0, "text": "runs past the end"},
            {"url": f"file://{voice}", "at_s": 0.2},  # no text: heard, not captioned
        ]},
        subtitles={"srt": "1\n00:00:00,500 --> 00:00:02,000\nMara: Not tonight.\n", "burn_in": False},
    )
    cues = out["subtitles"]
    assert [c["text"] for c in cues] == ["Mara: Not tonight.", "那一年，河水涨了十二米。", "runs past the end"]
    assert abs(cues[1]["start_s"] - 3.0) < 0.01 and abs(cues[1]["end_s"] - 4.7) < 0.1
    assert cues[2]["end_s"] <= out["duration_s"] + 0.05  # clipped to the film
    assert out["srt_url"].endswith(".srt")


def test_srt_round_trip_and_odd_blocks():
    srt = "1\n00:00:01,000 --> 00:00:02,500\nA\nB\n\nnot a cue\n\n7\n00:01:00.250 --> 00:01:01,000\nC\n"
    cues = h.parse_srt(srt)
    assert cues == [(1.0, 2.5, "A\nB"), (60.25, 61.0, "C")]
    assert h.format_srt(cues).startswith("1\n00:00:01,000 --> 00:00:02,500\nA\nB\n\n2\n00:01:00,250 --> 00:01:01,000\nC\n")
    assert h.merge_narration_cues("", [(2.0, 1.0, "x"), (0.5, 1.0, "")], 10) == [(2.0, 3.0, "x")]
