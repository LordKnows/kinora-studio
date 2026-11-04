import json
import subprocess
from pathlib import Path

import pytest

import handler_h3_runpod as h

HERE = Path(__file__).resolve().parent


def good_input(**over):
    base = {
        "workflow": "T2VA", "prompt": "a lighthouse in rain", "negative": "no text", "seconds": 5,
        "video_size": "1344x768", "steps": 8, "seed": 42, "enhance": False, "images": [],
        "output": {"key": "projects/p/shots/s/takes/t.mp4"}, "studio_take_id": "tke_1",
    }
    base.update(over)
    return base


# ---------- validation ----------


def test_validate_normalises_a_good_job():
    p = h.validate_input(good_input())
    assert (p["width"], p["height"]) == (1344, 768)
    assert p["seconds"] == 5.0 and p["seed"] == 42 and p["output_key"].endswith("t.mp4")


def test_validate_picks_a_seed_when_missing():
    p = h.validate_input(good_input(seed=None))
    assert isinstance(p["seed"], int)


@pytest.mark.parametrize(
    "over, message",
    [
        ({"workflow": "X2V"}, "workflow must be"),
        ({"prompt": ""}, "prompt must be"),
        ({"seconds": 40}, "seconds must be"),
        ({"video_size": "wide"}, "video_size"),
        ({"steps": 0}, "steps must be"),
        ({"output": {"key": "nope.mov"}}, "output.key"),
        ({"images": [{"url": "u", "role": "hero"}]}, "role of first_frame"),
        ({"workflow": "I2VA"}, "exactly one first_frame"),
        ({"workflow": "FL2VA", "images": [{"url": "a", "role": "first_frame"}]}, "one last_frame"),
        ({"workflow": "R2VA"}, "reference image or a source video"),
    ],
)
def test_validate_rejects_bad_jobs(over, message):
    with pytest.raises(h.JobError, match=message):
        h.validate_input(good_input(**over))


def test_derive_keys_puts_siblings_next_to_the_video():
    keys = h.derive_keys("projects/p/shots/s/takes/t.mp4")
    assert keys["last_frame"] == "projects/p/shots/s/takes/t.last.png"
    assert keys["thumbs"] == [f"projects/p/shots/s/takes/t.thumbs/{i}.jpg" for i in range(4)]


# ---------- graph filling ----------


def test_fill_graph_writes_every_mapped_field_into_the_placeholder():
    mapping = h.load_mapping(HERE / "workflows" / "mapping.json")["T2VA"]
    graph = h.load_workflow("T2VA", HERE / "workflows")
    params = h.validate_input(good_input(enhance=True))
    filled = h.fill_graph(graph, mapping, {**params, "files": {"reference": []}})
    assert filled["6"]["inputs"]["text"] == "a lighthouse in rain"
    assert filled["7"]["inputs"]["text"] == "no text"
    assert filled["3"]["inputs"] == {**graph["3"]["inputs"], "seconds": 5.0, "width": 1344, "height": 768, "steps": 8, "seed": 42}
    assert filled["9"]["inputs"]["enabled"] is True
    assert graph["6"]["inputs"]["text"] == ""  # the template is not mutated


def test_fill_graph_places_frames_and_references():
    graph = {"6": {"inputs": {}}, "3": {"inputs": {}}, "10": {"inputs": {}}, "11": {"inputs": {}}, "20": {"inputs": {}}, "21": {"inputs": {}}, "30": {"inputs": {}}}
    mapping = {"prompt": ["6", "text"], "seconds": ["3", "seconds"], "first_frame": ["10", "image"], "last_frame": ["11", "image"],
               "reference_images": [["20", "image"], ["21", "image"]], "video": ["30", "video"]}
    params = {**h.validate_input(good_input(workflow="R2VA", video="https://x/v.mp4")),
              "files": {"first_frame": "f.png", "last_frame": "l.png", "reference": ["r0.png", "r1.png"], "video": "v.mp4"}}
    filled = h.fill_graph(graph, mapping, params)
    assert filled["10"]["inputs"]["image"] == "f.png" and filled["11"]["inputs"]["image"] == "l.png"
    assert [filled["20"]["inputs"]["image"], filled["21"]["inputs"]["image"]] == ["r0.png", "r1.png"]
    assert filled["30"]["inputs"]["video"] == "v.mp4"


def test_fill_graph_refuses_more_references_than_slots_and_bad_nodes():
    params = {**h.validate_input(good_input(workflow="R2VA", images=[{"url": "u", "role": "reference"}])), "files": {"reference": ["a", "b"]}}
    with pytest.raises(h.JobError, match="accepts 1 reference"):
        h.fill_graph({"6": {"inputs": {}}, "3": {"inputs": {}}, "20": {"inputs": {}}}, {"prompt": ["6", "text"], "seconds": ["3", "s"], "reference_images": [["20", "image"]]}, params)
    with pytest.raises(h.JobError, match="not in the graph"):
        h.fill_graph({"6": {"inputs": {}}}, {"prompt": ["6", "text"], "seconds": ["99", "s"]}, {**params, "files": {"reference": []}})


# ---------- ffmpeg ----------


def make_clip(path: Path, seconds: float = 2.0) -> Path:
    subprocess.run(
        [h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=320x180:rate=24:duration={seconds}",
         "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path)],
        check=True,
    )
    return path


def test_extract_frames_produces_last_frame_and_four_thumbs(tmp_path):
    clip = make_clip(tmp_path / "clip.mp4")
    last, thumbs = h.extract_frames(clip, tmp_path)
    assert last.exists() and last.stat().st_size > 0
    assert len(thumbs) == 4 and all(t.stat().st_size > 0 for t in thumbs)
    width = subprocess.run([h.FFPROBE, "-v", "error", "-show_entries", "stream=width", "-of", "csv=p=0", str(thumbs[0])], capture_output=True, text=True, check=True).stdout.strip()
    assert width == "320"
    assert abs(h.probe_duration(clip) - 2.0) < 0.2


# ---------- end to end with ComfyUI and R2 mocked ----------


class FakeResponse:
    def __init__(self, payload=None, status=200, content=b""):
        self.payload, self.status_code, self._content, self.text = payload, status, content, json.dumps(payload or {})
        self.ok = status < 400

    def json(self):
        return self.payload

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(self.status_code)

    def iter_content(self, _n):
        yield self._content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeSession:
    def __init__(self, video_bytes: bytes):
        self.video = video_bytes
        self.calls = []
        self.polls = 0

    def get(self, url, **kw):
        self.calls.append(("GET", url))
        if "/history/" in url:
            self.polls += 1
            if self.polls < 2:
                return FakeResponse({})
            return FakeResponse({"pid-1": {"status": {"status_str": "success"}, "outputs": {"8": {"videos": [{"filename": "out.mp4", "subfolder": "", "type": "output"}]}}}})
        if "/view" in url:
            return FakeResponse(content=self.video)
        if url.startswith("https://assets/"):
            return FakeResponse(content=b"\x89PNG fake")
        return FakeResponse({"ok": True})

    def post(self, url, **kw):
        self.calls.append(("POST", url))
        if url.endswith("/upload/image"):
            return FakeResponse({"name": kw["files"]["image"][0]})
        if url.endswith("/prompt"):
            graph = kw["json"]["prompt"]
            assert graph["6"]["inputs"]["text"] == "a lighthouse in rain"
            assert graph["10"]["inputs"]["image"].startswith("first_frame")
            return FakeResponse({"prompt_id": "pid-1"})
        raise AssertionError(url)


class FakeUploader:
    def __init__(self):
        self.uploaded = []

    def upload(self, path, key, content_type):
        self.uploaded.append((Path(path).name, key, content_type))
        return f"https://cdn/{key}"


def test_run_job_end_to_end(tmp_path, monkeypatch):
    video = make_clip(tmp_path / "src.mp4").read_bytes()
    session = FakeSession(video)
    comfy = h.ComfyClient("http://comfy", session=session)
    mapping = {"I2VA": {"template": "T2VA", "prompt": ["6", "text"], "seconds": ["3", "seconds"], "first_frame": ["10", "image"], "output_node": "8"}}
    template_dir = tmp_path / "wf"
    template_dir.mkdir()
    graph = h.load_workflow("T2VA", HERE / "workflows")
    graph["10"] = {"class_type": "LoadImage", "inputs": {"image": ""}}
    (template_dir / "T2VA.json").write_text(json.dumps(graph))
    monkeypatch.setattr(h, "WORKFLOW_DIR", template_dir)
    monkeypatch.setattr(h.time, "sleep", lambda _s: None)

    params = h.validate_input(good_input(workflow="I2VA", images=[{"url": "https://assets/hero.png", "role": "first_frame"}]))
    uploader = FakeUploader()
    out = h.run_job(params, comfy, uploader, tmp_path, mapping)

    assert out["url"] == "https://cdn/projects/p/shots/s/takes/t.mp4"
    assert out["last_frame_url"].endswith("t.last.png")
    assert [u.rsplit("/", 1)[-1] for u in out["thumb_urls"]] == ["0.jpg", "1.jpg", "2.jpg", "3.jpg"]
    assert out["seed"] == 42 and out["execution_ms"] >= 0 and out["studio_take_id"] == "tke_1"
    assert [c for c in uploader.uploaded if c[2] == "video/mp4"][0][1] == "projects/p/shots/s/takes/t.mp4"
    assert ("POST", "http://comfy/upload/image") in session.calls and ("POST", "http://comfy/prompt") in session.calls


def test_handler_reports_job_errors_as_error_dict():
    assert "error" in h.handler({"input": {"workflow": "nope"}})


def test_handler_health_lists_templates(monkeypatch):
    monkeypatch.setattr(h, "WORKFLOW_DIR", HERE / "workflows")
    monkeypatch.setattr(h.ComfyClient, "health", lambda self: {"reachable": False})
    out = h.handler({"input": {"action": "health"}})
    assert out["ok"] and out["workflows"] == ["T2VA"]
