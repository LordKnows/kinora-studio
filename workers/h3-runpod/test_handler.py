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
    assert filled["104"]["inputs"] == {**graph["104"]["inputs"], "prompt": "a lighthouse in rain", "length": 124, "width": 1344, "height": 768}
    assert filled["9"]["inputs"]["steps"] == 8
    assert filled["15"]["inputs"]["noise_seed"] == 42
    assert graph["104"]["inputs"]["prompt"] == h.load_workflow("T2VA", HERE / "workflows")["104"]["inputs"]["prompt"]  # the template is not mutated
    assert h.seconds_to_frames(10) == 243 and h.seconds_to_frames(15) == 362 and h.seconds_to_frames(1) == 124


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
            return FakeResponse({"pid-1": {"status": {"status_str": "success"}, "outputs": {"92": {"images": [{"filename": "out.mp4", "subfolder": "", "type": "output"}]}}}})
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
            assert graph["104"]["inputs"]["prompt"] == "a lighthouse in rain"
            assert graph["200"]["inputs"]["image"].startswith("first_frame")
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
    mapping = {"I2VA": {"template": "T2VA", "prompt": ["104", "prompt"], "length": ["104", "length"], "first_frame": ["200", "image"], "output_node": "92"}}
    template_dir = tmp_path / "wf"
    template_dir.mkdir()
    graph = h.load_workflow("T2VA", HERE / "workflows")
    graph["200"] = {"class_type": "LoadImage", "inputs": {"image": ""}}
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
    assert out["ok"] and out["workflows"] == ["FL2VA", "H3_IMAGE", "I2VA", "I2VA_GUIDE", "R2VA", "REGEN", "REMAKE", "T2VA"] and "remake" in out
    assert list(out["image_models"]) == ["minimax-h3-image"]
    assert out["image_models"]["minimax-h3-image"] == {"ready": False, "workflow": "H3_IMAGE", "missing": [
        "diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors", "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "vae/minimax_h3_image_vae_fp16.safetensors"]}


# ---- LoRAs ----


def test_validate_accepts_loras_and_rejects_paths():
    base = {"workflow": "T2VA", "prompt": "x", "seconds": 5, "output": {"key": "a/b.mp4"}}
    params = h.validate_input({**base, "loras": [{"file": "speed.safetensors", "strength": 0.8, "hf_url": "https://huggingface.co/o/r/blob/main/speed.safetensors"}]})
    assert params["loras"][0]["strength"] == 0.8
    with pytest.raises(h.JobError):
        h.validate_input({**base, "loras": [{"file": "../evil.safetensors"}]})
    with pytest.raises(h.JobError):
        h.validate_input({**base, "loras": [{"file": "x.safetensors", "strength": 5}]})


def test_fill_graph_sets_lora_slots_and_neutralises_unused():
    mapping = h.load_mapping()["T2VA"]
    graph = h.load_workflow("T2VA")
    params = {"prompt": "p", "negative": "", "seconds": 5, "width": 1344, "height": 768, "steps": 8, "seed": 1, "enhance": False, "files": {},
              "loras": [{"file": "speed.safetensors", "strength": 0.9}]}
    filled = h.fill_graph(graph, mapping, params)
    assert filled["7"]["inputs"]["lora_name"] == "speed.safetensors"
    assert filled["7"]["inputs"]["strength_model"] == 0.9
    empty = h.fill_graph(graph, mapping, {**params, "loras": []})
    assert empty["7"]["inputs"]["strength_model"] == 0.0
    untouched = h.fill_graph(graph, mapping, {k: v for k, v in params.items() if k != "loras"})
    assert untouched["7"]["inputs"]["lora_name"] == graph["7"]["inputs"]["lora_name"]


@pytest.mark.parametrize("workflow", ["T2VA", "I2VA", "I2VA_GUIDE", "FL2VA", "R2VA"])
def test_fill_graph_chains_extra_loras_after_the_slot(workflow):
    """A speed LoRA plus style LoRAs: the templates carry one slot, the rest are chained behind it."""
    mapping = json.loads((HERE / "workflows" / "mapping.json").read_text())[workflow]
    graph = json.loads((HERE / "workflows" / f"{mapping['template']}.json").read_text())
    readers = [(nid, name) for nid, node in graph.items() for name, v in node["inputs"].items() if v == ["7", 0]]
    assert readers, "something reads the LoRA'd model"
    params = {"prompt": "p", "negative": "", "seconds": 5, "width": 1344, "height": 768, "steps": 8, "seed": 1, "enhance": False, "files": {},
              "loras": [{"file": "speed.safetensors", "strength": 1.0}, {"file": "realism.safetensors", "strength": 0.7}, {"file": "camera.safetensors", "strength": 0.6}]}
    params["files"] = {"I2VA": {"first_frame": "a.png"}, "I2VA_GUIDE": {"first_frame": "a.png", "guide_audio": "g.wav"}, "FL2VA": {"first_frame": "a.png", "last_frame": "b.png"},
                       "R2VA": {"reference": ["r.png"]}}.get(workflow, {})
    filled = h.fill_graph(graph, mapping, params)
    assert filled["7"]["inputs"]["lora_name"] == "speed.safetensors" and filled["7"]["inputs"]["strength_model"] == 1.0
    second, third = filled["7_lora1"], filled["7_lora2"]
    assert second["class_type"] == "LoraLoaderModelOnly" and second["inputs"] == {"model": ["7", 0], "lora_name": "realism.safetensors", "strength_model": 0.7}
    assert third["inputs"] == {"model": ["7_lora1", 0], "lora_name": "camera.safetensors", "strength_model": 0.6}
    for nid, name in readers:
        assert filled[nid]["inputs"][name] == ["7_lora2", 0]
    assert not [1 for nid, node in filled.items() if nid not in ("7_lora1",) for v in node["inputs"].values() if v == ["7", 0]]
    # the template itself is not touched, and one LoRA still fills the slot alone
    assert "7_lora1" not in graph
    one = h.fill_graph(graph, mapping, {**params, "loras": params["loras"][:1]})
    assert "7_lora1" not in one and one[readers[0][0]]["inputs"][readers[0][1]] == ["7", 0]
    with pytest.raises(h.JobError, match="at most 4"):
        h.fill_graph(graph, mapping, {**params, "loras": params["loras"] * 2})


def test_fill_graph_refuses_extra_loras_on_a_loader_it_cannot_chain():
    mapping = {"prompt": ["1", "text"], "seconds": ["1", "seconds"], "loras": [{"node": "3", "name": "lora_name", "strength": "strength"}]}
    graph = {"1": {"class_type": "X", "inputs": {"text": ""}}, "3": {"class_type": "OpenH3RegenLora", "inputs": {"lora_name": "a", "strength": 1.0}}}
    params = {"prompt": "p", "negative": "", "seconds": 5, "width": 1, "height": 1, "steps": 3, "seed": 1, "enhance": False, "files": {},
              "loras": [{"file": "a.safetensors", "strength": 1.0}, {"file": "b.safetensors", "strength": 1.0}]}
    with pytest.raises(h.JobError, match="cannot be chained"):
        h.fill_graph(graph, mapping, params)


def test_ensure_loras_downloads_missing_from_hf(tmp_path):

    class Res:
        status_code = 200

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def iter_content(self, chunk_size):
            yield b"weights"

    class Session:
        calls = []

        def get(self, url, stream=False, timeout=0, headers=None):
            Session.calls.append(url)
            return Res()

    paths = h.ensure_loras([{"file": "s.safetensors", "strength": 1, "hf_url": "https://huggingface.co/o/r/blob/main/s.safetensors"}], lora_dir=tmp_path, session=Session())
    assert paths[0].read_bytes() == b"weights"
    assert Session.calls == ["https://huggingface.co/o/r/resolve/main/s.safetensors"]
    # second call: already present, no download
    h.ensure_loras([{"file": "s.safetensors", "strength": 1, "hf_url": None}], lora_dir=tmp_path, session=Session())
    assert len(Session.calls) == 1
    with pytest.raises(h.JobError):
        h.ensure_loras([{"file": "missing.safetensors", "strength": 1, "hf_url": None}], lora_dir=tmp_path, session=Session())


def test_r2va_grows_reference_slots_beyond_the_template(tmp_path):
    mapping = h.load_mapping()["R2VA"]
    graph = h.load_workflow("R2VA")
    params = {"prompt": "p", "negative": "", "seconds": 5, "width": 1344, "height": 768, "steps": 8, "seed": 1, "enhance": False,
              "files": {"reference": ["a.png", "b.png", "c.png", "d.png"]}}
    filled = h.fill_graph(graph, mapping, params)
    assert filled["201"]["inputs"]["image"] == "a.png" and filled["202"]["inputs"]["image"] == "b.png"
    assert filled["201_ref2"]["inputs"]["image"] == "c.png" and filled["201_ref2"]["class_type"] == "LoadImage"
    assert filled["104"]["inputs"]["ref_images.ref_image_2"] == ["201_ref2", 0]
    assert filled["104"]["inputs"]["ref_images.ref_image_3"] == ["201_ref3", 0]
    assert "201_ref2" not in graph  # template untouched
    with pytest.raises(h.JobError):
        h.fill_graph(graph, mapping, {**params, "files": {"reference": [f"{i}.png" for i in range(10)]}})


def test_models_status_reports_missing_and_accepts_unet_alias(tmp_path):
    import handler
    base = tmp_path / "models"
    (base / "unet").mkdir(parents=True)
    (base / "vae").mkdir()
    # whole (the list's size; a sparse file) under the unet alias: present
    with open(base / "unet" / "minimax_h3_fl2va_pruned_int8_convrot.safetensors", "wb") as fh:
        fh.truncate(20970379616)
    # cut off: missing, so the next boot fetches it again
    (base / "vae" / "minimax_h3_video_vae_fp16.safetensors").write_bytes(b"x" * 2_000_000)
    status = handler.models_status(base)
    assert status["expected"] == 7
    assert status["ready"] is False
    assert "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors" not in status["missing"]
    assert "vae/minimax_h3_video_vae_fp16.safetensors" in status["missing"]


def test_downloads_status_says_what_is_left_and_whether_the_chain_runs(tmp_path, monkeypatch):
    import os

    import handler
    state, base = tmp_path / "state", tmp_path / "models"
    (base / "vae").mkdir(parents=True)
    state.mkdir()
    monkeypatch.setenv("DOWNLOAD_STATE_DIR", str(state))
    for switch in ("H3_IMAGE", "REGEN_2K"):
        monkeypatch.setenv(switch, "0")
    idle = handler.downloads_status(base)
    assert idle["active"] is False and idle["gb_left"] > 60 and len(idle["missing"]) == 7
    # MiniMax-H3-Image adds its DiT and VAE: the text encoder is the video set's file, counted once (+22 GB)
    monkeypatch.setenv("H3_IMAGE", "1")
    with_image = handler.downloads_status(base)
    assert len(with_image["missing"]) == 9 and round(with_image["gb_left"] - idle["gb_left"], 1) == 22.1
    monkeypatch.setenv("H3_IMAGE", "0")
    # the chain runs (its pid is this process), on a file half down
    (state / "chain.pid").write_text(str(os.getpid()))
    (state / "current").write_text("models.txt minimax_h3_video_vae_fp16.safetensors 5207808496")
    with open(base / "vae" / "minimax_h3_video_vae_fp16.safetensors.part", "wb") as fh:
        fh.truncate(5_000_000_000)
    (state / "failed").write_text("models.txt minimax_h3_audio_vae_fp32.safetensors\n")
    busy = handler.downloads_status(base)
    assert busy["active"] is True and busy["current"].startswith("models.txt minimax_h3_video_vae")
    assert round(idle["gb_left"] - busy["gb_left"], 1) == 5.0
    assert busy["failed"] == ["models.txt minimax_h3_audio_vae_fp32.safetensors"]
    # a pid that is gone: the chain is not running any more
    (state / "chain.pid").write_text("999999")
    assert handler.downloads_status(base)["active"] is False


def test_sampling_profile_patches_sampler_scheduler_and_shift():
    mapping = h.load_mapping()["T2VA"]
    graph = h.load_workflow("T2VA")
    params = h.validate_input(good_input(steps=20, loras=[], sampling={"sampler": "res_multistep", "scheduler": "simple", "shift_video": 12.0, "shift_audio": 3.0}))
    patched = h.fill_graph(graph, mapping, {**params, "files": {}})
    assert patched["17"]["inputs"]["sampler_name"] == "res_multistep"
    assert patched["9"]["inputs"]["scheduler"] == "simple"
    assert patched["9"]["inputs"]["steps"] == 20
    assert patched["8"]["inputs"]["shift_video"] == 12.0
    assert patched["8"]["inputs"]["shift_audio"] == 3.0
    assert patched["7"]["inputs"]["strength_model"] == 0.0
    with pytest.raises(h.JobError):
        h.validate_input(good_input(sampling={"sampler": "rm -rf"}))


def test_wait_stops_comfy_when_the_job_is_cancelled():
    posted: list[tuple[str, dict | None]] = []

    class FakeHTTP:
        def get(self, url, **kw):
            class R:
                def raise_for_status(self):
                    pass

                def json(self):
                    return {}
            return R()

        def post(self, url, json=None, **kw):  # noqa: A002
            posted.append((url, json))

    comfy = h.ComfyClient()
    comfy.http = FakeHTTP()
    with pytest.raises(h.JobError, match="cancelled"):
        comfy.wait("p1", timeout_s=5, poll_s=0.01, should_cancel=lambda: True)
    assert [u.rsplit("/", 1)[-1] for u, _ in posted] == ["queue", "interrupt"]
    assert posted[0][1] == {"delete": ["p1"]}


def test_ensure_loras_resolves_a_repo_link_to_its_weight_file(tmp_path):
    class Res:
        def __init__(self, payload=None):
            self.status_code = 200
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def json(self):
            return self.payload

        def iter_content(self, chunk_size):
            yield b"w"

    class Session:
        calls: list[str] = []

        def get(self, url, stream=False, timeout=0, headers=None):
            Session.calls.append(url)
            if "/api/models/" in url:
                return Res({"siblings": [
                    {"rfilename": "README.md", "size": 10},
                    {"rfilename": "camera_motion_v1_1000_pruned.safetensors", "size": 300},
                    {"rfilename": "camera_motion_v1_3000_pruned.safetensors", "size": 310},
                ]})
            return Res()

    assert h.hf_repo_of("https://huggingface.co/Jojocodex/minimax-h3-Camera-Motion-lora") == "Jojocodex/minimax-h3-Camera-Motion-lora"
    assert h.hf_repo_of("https://huggingface.co/Jojocodex/minimax-h3-Camera-Motion-lora/tree/main") == "Jojocodex/minimax-h3-Camera-Motion-lora"
    assert h.hf_repo_of("https://huggingface.co/o/r/blob/main/s.safetensors") is None
    paths = h.ensure_loras([{"file": "jojocodex_camera_motion.safetensors", "strength": 0.6, "hf_url": "https://huggingface.co/Jojocodex/minimax-h3-Camera-Motion-lora"}], lora_dir=tmp_path, session=Session())
    assert paths[0].name == "jojocodex_camera_motion.safetensors" and paths[0].read_bytes() == b"w"
    assert Session.calls[-1] == "https://huggingface.co/Jojocodex/minimax-h3-Camera-Motion-lora/resolve/main/camera_motion_v1_3000_pruned.safetensors"


def test_progress_watcher_turns_comfy_messages_into_stages():
    seen: list[dict] = []
    w = h.ProgressWatcher("http://127.0.0.1:8188", "cid", {"6": "UNETLoader", "14": "SamplerCustomAdvanced", "10": "VAEDecode"}, seen.append)
    w.prompt_id = "p1"
    w.handle({"type": "executing", "data": {"node": "6", "prompt_id": "p1"}})
    assert seen[-1]["stage"] == "loading"
    w.handle({"type": "executing", "data": {"node": "14", "prompt_id": "other"}})  # another prompt: ignored
    assert seen[-1]["stage"] == "loading"
    w.handle({"type": "progress", "data": {"value": 1, "max": 8, "prompt_id": "p1"}})
    w._steps[0] = (w._steps[0][0] - 60.0, 1)  # pretend a minute passed
    w.handle({"type": "progress", "data": {"value": 2, "max": 8, "prompt_id": "p1"}})
    last = seen[-1]
    assert last["stage"] == "sampling" and last["step"] == 2 and last["total"] == 8 and last["percent"] == 25
    assert 55 <= last["secondsPerStep"] <= 65 and 330 <= last["etaSeconds"] <= 390
    w.handle({"type": "executing", "data": {"node": "10", "prompt_id": "p1"}})
    assert seen[-1]["stage"] == "decoding"
    w.handle({"type": "execution_success", "data": {"prompt_id": "p1"}})
    assert seen[-1]["stage"] == "finishing"


def test_download_image_rejects_html_and_accepts_real_images(tmp_path):
    class Res:
        def __init__(self, body):
            self.body = body

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def raise_for_status(self):
            pass

        def iter_content(self, n):
            yield self.body

    class Session:
        body = b""

        def get(self, url, stream=False, timeout=0):
            return Res(Session.body)

    Session.body = b"<!DOCTYPE html><html><body>Sign in</body></html>"
    with pytest.raises(h.JobError, match="HTML page"):
        h.download_image("https://studio/media/a.png", tmp_path / "ref_0.png", Session())
    Session.body = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    assert h.download_image("https://studio/media/a.png", tmp_path / "ref_1.png", Session()).name == "ref_1.png"
    Session.body = b"RIFF\x00\x00\x00\x00WEBPVP8 "
    assert h.sniff_image(h.download_image("https://studio/media/a.webp", tmp_path / "ref_2.webp", Session())) == "webp"
    assert h.sniff_image(tmp_path / "nope") is None


def test_fill_graph_drops_unused_reference_slots():
    mapping = h.load_mapping()["R2VA"]
    graph = h.load_workflow("R2VA")
    params = h.validate_input(good_input(workflow="R2VA", images=[{"url": "https://r2/a.png", "role": "reference"}]))
    filled = h.fill_graph(graph, mapping, {**params, "files": {"reference": ["reference0.png"]}})
    assert filled["201"]["inputs"]["image"] == "reference0.png"
    assert "202" not in filled
    assert "ref_images.ref_image_1" not in filled["104"]["inputs"]
    assert filled["104"]["inputs"]["ref_images.ref_image_0"] == ["201", 0]
    # two references: both slots used, nothing dropped
    two = h.fill_graph(h.load_workflow("R2VA"), mapping, {**params, "files": {"reference": ["a.png", "b.png"]}})
    assert two["202"]["inputs"]["image"] == "b.png" and two["104"]["inputs"]["ref_images.ref_image_1"] == ["202", 0]


def test_progress_watcher_reads_progress_state_messages():
    seen: list[dict] = []
    w = h.ProgressWatcher("http://127.0.0.1:8188", "cid", {"14": "SamplerCustomAdvanced"}, seen.append)
    w.handle({"type": "progress_state", "data": {"prompt_id": "p", "nodes": {"14": {"state": "running", "value": 5, "max": 8}}}})
    assert seen[-1]["stage"] == "sampling" and seen[-1]["step"] == 5 and seen[-1]["percent"] == 62
    w.handle({"type": "progress_state", "data": {"prompt_id": "p", "nodes": {"14": {"state": "running", "value": 5, "max": 8}}}})
    assert len(seen) == 1  # the same step again is not re-reported


def test_regen_input_and_graph(tmp_path):
    params = h.validate_input({"workflow": "REGEN", "video": "https://studio/media/t.mp4", "prompt": "a fox in the snow", "resolution": "2k", "start_sigma": 0.8, "output": {"key": "p/s/t_2k.mp4"}, "sparse": True})
    assert params["workflow"] == "REGEN" and params["resolution"] == "2k" and params["seed"] == 1766580932
    with pytest.raises(h.JobError):
        h.validate_input({"workflow": "REGEN", "video": "nope", "prompt": "x", "output": {"key": "a.mp4"}})
    with pytest.raises(h.JobError):
        h.validate_input({"workflow": "REGEN", "video": "https://x/y.mp4", "prompt": "x", "resolution": "8k", "output": {"key": "a.mp4"}})
    mapping = h.load_mapping()["REGEN"]
    graph = h.load_workflow("REGEN")
    # without the sparse node class on the pod: dense, guider reads the LoRA'd model
    filled = h.fill_regen_graph(graph, mapping, {**params, "files": {"video": "draft.mp4"}}, set())
    assert filled["9"]["inputs"]["file"] == "draft.mp4"
    assert filled["16"]["inputs"]["text"] == "a fox in the snow"
    assert filled["17"]["inputs"]["resolution"] == "2k (2560x1440)"
    assert filled["19"]["inputs"]["start_sigma"] == 0.8 and filled["19"]["inputs"]["steps"] == 3
    assert filled["11"]["inputs"]["max_frames"] == 0
    assert filled["22"]["inputs"]["model"] == ["3", 0] and "4" not in filled
    # with it: inserted between LoRA and guider, inputs named from object_info
    h.node_classes_info["BlockSparseAttention"] = {"required": {"model": ["MODEL"], "method": [["sol-attn"]], "tau": ["FLOAT"], "min_keep": ["FLOAT"], "max_keep": ["FLOAT"], "dense_layers": ["STRING"], "block_q": ["INT"], "block_kv": ["INT"], "mode": [["exact_kv_and_rows"]], "enabled": ["BOOLEAN"]}}
    sparse = h.fill_regen_graph(graph, mapping, {**params, "files": {"video": "draft.mp4"}}, {"BlockSparseAttention"})
    assert sparse["4"]["class_type"] == "BlockSparseAttention" and sparse["4"]["inputs"]["model"] == ["3", 0] and sparse["4"]["inputs"]["tau"] == 1.2
    assert sparse["22"]["inputs"]["model"] == ["4", 0]
    status = h.regen_status(tmp_path)
    assert status["ready"] is False and len(status["missing"]) == 4
    # decoder choice: core (default) drops the fast decoder, fast drops the core pair
    core = h.fill_regen_graph(graph, mapping, {**params, "files": {"video": "draft.mp4"}}, set())
    assert core["26"]["inputs"]["images"] == ["31", 0] and "25" not in core and core["30"]["inputs"]["samples"] == ["24", 0]
    fast = h.fill_regen_graph(graph, mapping, {**h.validate_input({**{"workflow": "REGEN", "video": "https://x/y.mp4", "prompt": "p", "output": {"key": "a.mp4"}}, "decoder": "fast"}), "files": {"video": "d.mp4"}}, set())
    assert fast["26"]["inputs"]["images"] == ["25", 0] and "31" not in fast and "30" not in fast and "vae" not in fast["25"]["inputs"]
    # rescue: decode-only graph from the saved latent
    rescue = h.rescue_graph(graph, mapping, "open_h3_regen_00001.safetensors")
    assert rescue["40"]["inputs"]["latent_file"] == "open_h3_regen_00001.safetensors"
    assert rescue["26"]["inputs"] == {"images": ["31", 0], "frame_count": ["40", 1], "crop": "auto (1088 -> 1080, 2176 -> 2160)", "audio": ["40", 2]}
    assert set(rescue) == {"7", "40", "30", "31", "26", "27", "28"}


def test_studio_video_latent_node_keeps_the_video_half():
    import importlib.util
    spec = importlib.util.spec_from_file_location("studio_nodes", HERE / "studio_nodes" / "__init__.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class Nested:
        tensors = ["video", "audio"]

    node = mod.StudioH3VideoLatent()
    assert node.split({"samples": Nested()})[0]["samples"] == "video"
    assert node.split({"samples": "plain"})[0]["samples"] == "plain"
    assert "StudioH3VideoLatent" in mod.NODE_CLASS_MAPPINGS


# ---------- voice: reference audio (R2VA) and the audio guide (I2VA) ----------


def test_validate_audios_belong_to_r2va_and_respect_the_model_card():
    ok = h.validate_input(good_input(workflow="R2VA", images=[{"url": "u", "role": "reference"}], audios=[{"url": "https://x/a.wav", "role": "reference", "seconds": 4}]))
    assert ok["audios"] == [{"url": "https://x/a.wav", "seconds": 4.0}] and ok["guide_audio"] is None
    with pytest.raises(h.JobError, match="need the R2VA workflow"):
        h.validate_input(good_input(audios=[{"url": "https://x/a.wav"}]))
    with pytest.raises(h.JobError, match="at most 3 reference audios"):
        h.validate_input(good_input(workflow="R2VA", images=[{"url": "u", "role": "reference"}], audios=[{"url": f"https://x/{i}.wav"} for i in range(4)]))
    with pytest.raises(h.JobError, match="between 2 and 15"):
        h.validate_input(good_input(workflow="R2VA", images=[{"url": "u", "role": "reference"}], audios=[{"url": "https://x/a.wav", "seconds": 1}]))


def test_validate_guide_audio_belongs_to_i2va():
    first = [{"url": "f", "role": "first_frame"}]
    ok = h.validate_input(good_input(workflow="I2VA", images=first, guide_audio={"url": "https://x/line.wav", "frame": 36}))
    assert ok["guide_audio"] == {"url": "https://x/line.wav", "frame": 36}
    with pytest.raises(h.JobError, match="needs the I2VA workflow"):
        h.validate_input(good_input(guide_audio={"url": "https://x/line.wav", "frame": 0}))
    with pytest.raises(h.JobError, match="frame index"):
        h.validate_input(good_input(workflow="I2VA", images=first, guide_audio={"url": "https://x/line.wav", "frame": -1}))


def test_reference_audio_fits_the_15_second_total():
    assert h.reference_audio_seconds([{"seconds": 10.0}, {"seconds": 10.0}, {"seconds": 10.0}]) == [10.0, 5.0]
    assert h.reference_audio_seconds([{"seconds": 14.0}, {"seconds": 3.0}]) == [14.0]


def test_fill_graph_wires_reference_audio_into_r2va():
    mapping = h.load_mapping()["R2VA"]
    graph = h.load_workflow("R2VA", HERE / "workflows")
    params = {**h.validate_input(good_input(workflow="R2VA", images=[{"url": "u", "role": "reference"}])), "files": {"reference": ["r0.png"], "reference_audio": ["a0.wav", "a1.wav"]}}
    filled = h.fill_graph(graph, mapping, params)
    assert filled["ref_audio_0"] == {"class_type": "LoadAudio", "inputs": {"audio": "a0.wav"}, "_meta": {"title": "Reference Audio 0"}}
    assert filled["104"]["inputs"]["ref_audios.ref_audio_0"] == ["ref_audio_0", 0]
    assert filled["104"]["inputs"]["ref_audios.ref_audio_1"] == ["ref_audio_1", 0]
    assert filled["104"]["inputs"]["audio_vae"] == ["24", 0]  # without the audio VAE the reference only reaches the text encoder
    with pytest.raises(h.JobError, match="takes no reference audio"):
        h.fill_graph(h.load_workflow("T2VA", HERE / "workflows"), h.load_mapping()["T2VA"], {**h.validate_input(good_input()), "files": {"reference": [], "reference_audio": ["a0.wav"]}})


def test_i2va_guide_graph_anchors_the_line_and_feeds_the_guider():
    mapping = h.load_mapping()["I2VA_GUIDE"]
    graph = h.load_workflow(mapping["template"], HERE / "workflows")
    assert graph["211"]["class_type"] == "MiniMaxH3AddGuide" and graph["16"]["inputs"]["conditioning"] == ["211", 0]
    assert graph["14"]["inputs"]["latent_image"] == ["104", 1]
    params = {**h.validate_input(good_input(workflow="I2VA", images=[{"url": "f", "role": "first_frame"}], guide_audio={"url": "https://x/line.wav", "frame": 36})),
              "files": {"first_frame": "f.png", "reference": [], "guide_audio": "g.wav"}}
    filled = h.fill_graph(graph, mapping, params)
    assert filled["210"]["inputs"]["audio"] == "g.wav" and filled["211"]["inputs"]["frame_idx"] == 36
    assert filled["200"]["inputs"]["image"] == "f.png"
    # every mapped node exists in the template
    for field in ("prompt", "length", "width", "height", "steps", "seed", "first_frame", "guide_audio", "guide_frame", "sampler", "scheduler"):
        assert mapping[field][0] in graph, field


def test_prepare_audio_cuts_and_makes_stereo(tmp_path):
    src = tmp_path / "mono.wav"
    subprocess.run([h.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=3", "-ac", "1", "-ar", "24000", str(src)], check=True)
    out = h.prepare_audio(src, tmp_path / "ref.wav", 2.0)
    info = subprocess.run([h.FFPROBE, "-v", "error", "-show_entries", "stream=channels,sample_rate", "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True).stdout.strip()
    assert info == "48000,2"
    assert abs(h.probe_duration(out) - 2.0) < 0.05
    clip = make_clip(tmp_path / "clip.mp4", 2.0)  # a video's soundtrack works too
    assert h.prepare_audio(clip, tmp_path / "from_video.wav").exists()
    with pytest.raises(h.JobError, match="could not read the audio"):
        h.prepare_audio(tmp_path / "missing.wav", tmp_path / "x.wav")
