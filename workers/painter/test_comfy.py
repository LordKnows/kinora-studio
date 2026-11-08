"""Image models on the GPU pod (paint.py run_comfy): the painter advertises
a model only when ComfyUI answers and its weights are on disk; a job fills
the model's API graph (reference slots in order, unused ones dropped, the
Studio's settings), checks the graph against this ComfyUI first, and comes
back as one picture."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint  # noqa: E402

POD = HERE.parent / "h3-runpod"
MANIFESTS = json.loads((POD / "workflows" / "image_models.json").read_text())
MANIFEST = MANIFESTS["qwen-image-2.1-turbo"]
GRAPH = json.loads((POD / "workflows" / "QWEN21_EDIT.json").read_text())
BASE_GRAPH = json.loads((POD / "workflows" / "QWEN21_EDIT_BASE.json").read_text())
OMNI = "chatrlabs-omni-lora-v0.1-bf16.safetensors"


def png(color=(10, 120, 200), size=(512, 768)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class Res:
    def __init__(self, status=200, payload=None, content=b""):
        self.status_code, self._payload, self.content = status, payload, content
        self.ok = status < 400
        self.text = json.dumps(payload) if payload is not None else ""

    def json(self):
        return self._payload

    def iter_content(self, n):
        yield self.content

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def object_info(graph):
    """What a ComfyUI that has every node and file of the graph answers."""
    info = {}
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        spec = {}
        for name, value in node["inputs"].items():
            if "." in name or isinstance(value, list):
                continue
            spec[name] = [[value]] if name in ("unet_name", "clip_name", "vae_name") else ["STRING"]
        info.setdefault(node["class_type"], {"input": {"required": {}}})["input"]["required"].update(spec)
    return info


class FakeComfy:
    def __init__(self, missing_node=None, missing_file=False, graph=None, loras=()):
        self.info = object_info({k: v for k, v in (graph or GRAPH).items() if not k.startswith("_")})
        self.info["LoraLoaderModelOnly"] = {"input": {"required": {"model": ["MODEL"], "lora_name": [list(loras)], "strength_model": ["FLOAT"]}}}
        self.downloads = []
        if missing_node:
            self.info.pop(missing_node)
        if missing_file:
            self.info["UNETLoader"]["input"]["required"]["unet_name"] = [["something_else.safetensors"]]
        self.uploads, self.queued = [], []

    def get(self, url, params=None, timeout=0, stream=False, headers=None):
        if url.startswith("https://huggingface.co/"):
            self.downloads.append(url)
            return Res(content=b"\0" * 1_000_001)
        if url.endswith("/system_stats"):
            return Res(payload={"system": {}})
        if "/object_info/" in url:
            cls = url.rsplit("/", 1)[-1]
            return Res(payload={cls: self.info[cls]} if cls in self.info else {})
        if "/history/" in url:
            pid = url.rsplit("/", 1)[-1]
            return Res(payload={pid: {"status": {"status_str": "success"}, "outputs": {"28": {"images": [{"filename": "canvas_00001_.png", "subfolder": "studio", "type": "output"}]}}}})
        if url.endswith("/view"):
            return Res(content=png((200, 30, 30), (1024, 1536)))
        raise AssertionError(url)

    def post(self, url, json=None, files=None, data=None, timeout=0):
        if url.endswith("/upload/image"):
            name = files["image"][0]
            self.uploads.append(name)
            return Res(payload={"name": name, "subfolder": "studio"})
        if url.endswith("/prompt"):
            self.queued.append(json["prompt"])
            return Res(payload={"prompt_id": "p1"})
        raise AssertionError(url)


@pytest.fixture
def weights(tmp_path, monkeypatch):
    for line in (POD / MANIFEST["files"]).read_text().splitlines() + (POD / MANIFESTS["qwen-image-2.1"]["files"]).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        subdir, _, url = line.partition("\t")
        d = tmp_path / subdir
        d.mkdir(parents=True, exist_ok=True)
        (d / url.rsplit("/", 1)[-1]).write_bytes(b"\0" * 1_000_001)
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(paint, "COMFY_POLL_S", 0)
    return tmp_path


def pictures(tmp_path, n):
    out = []
    for i in range(n):
        p = tmp_path / f"ref{i}.png"
        p.write_bytes(png())
        out.append(p)
    return out


def test_the_painter_advertises_a_model_only_with_its_weights(tmp_path, monkeypatch):
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    assert paint.comfy_backends(FakeComfy()) == []
    for line in (POD / MANIFEST["files"]).read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            subdir, _, url = line.partition("\t")
            # diffusion_models and unet are one folder type to ComfyUI
            d = tmp_path / ("unet" if subdir == "diffusion_models" else subdir)
            d.mkdir(parents=True, exist_ok=True)
            (d / url.rsplit("/", 1)[-1]).write_bytes(b"\0" * 1_000_001)
    assert paint.comfy_backends(FakeComfy()) == ["comfy:qwen-image-2.1-turbo"]

    class Down(FakeComfy):
        def get(self, url, **kw):
            raise paint.requests.ConnectionError("no comfy")

    assert paint.comfy_backends(Down()) == []


def test_a_job_fills_the_graph_in_order_and_drops_unused_slots(tmp_path, weights):
    comfy = FakeComfy()
    settings = paint._settings({"steps": 8, "cfg": 1, "sampler": "euler", "sigmas": [1.0, 0.5, 0], "resolution": 1024, "seed": 7, "junk": 1})
    img = paint.run_comfy("qwen-image-2.1-turbo", "<image1> wears <image2>", pictures(tmp_path, 3), 1000, 1500, settings, comfy)
    assert img.size == (1024, 1536)
    g = comfy.queued[0]
    enc = g["20"]["inputs"]
    assert enc["prompt"] == "<image1> wears <image2>" and enc["resolution"] == 1024
    assert [k for k in enc if k.startswith("images.")] == ["images.image_1", "images.image_2", "images.image_3"]
    assert "34" not in g and "33" in g
    assert [g[n]["inputs"]["image"] for n in ("31", "32", "33")] == ["studio/ref0.png", "studio/ref1.png", "studio/ref2.png"]
    assert (g["21"]["inputs"]["width"], g["21"]["inputs"]["height"]) == (992, 1504)
    assert g["22"]["inputs"]["noise_seed"] == 7 and g["25"]["inputs"]["cfg"] == 1.0 and g["24"]["inputs"]["sigmas"] == "1, 0.5, 0"


def test_the_preflight_names_what_this_comfyui_lacks(tmp_path, weights):
    with pytest.raises(paint.PaintError, match="lacks the nodes TextEncodeQwenImage21"):
        paint.run_comfy("qwen-image-2.1-turbo", "a prompt", pictures(tmp_path, 1), 1024, 1024, {}, FakeComfy(missing_node="TextEncodeQwenImage21"))
    with pytest.raises(paint.PaintError, match="unet_name = qwen_image_2.1_turbo_int8_convrot.safetensors is not in this ComfyUI"):
        paint.run_comfy("qwen-image-2.1-turbo", "a prompt", pictures(tmp_path, 1), 1024, 1024, {}, FakeComfy(missing_file=True))


def test_missing_weights_and_unknown_models_fail_clearly(tmp_path, monkeypatch):
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    with pytest.raises(paint.PaintError, match="model files not on the pod yet"):
        paint.run_comfy("qwen-image-2.1-turbo", "a prompt", [], 1024, 1024, {}, FakeComfy())
    with pytest.raises(paint.PaintError, match="no image model"):
        paint.run_comfy("nope", "a prompt", [], 1024, 1024, {}, FakeComfy())


def test_validation_accepts_comfy_backends_with_up_to_ten_pictures():
    base = {"op": "paint", "prompt": "a picture", "size": "1024x1536", "output": {"key": "projects/p/images/j.png"}}
    ok = paint.validate_paint_input({**base, "backend": "comfy:qwen-image-2.1-turbo", "refs": [f"https://x/{i}.png" for i in range(10)], "params": {"steps": 8, "sigmas": [1, 0]}})
    assert ok["backend"] == "comfy:qwen-image-2.1-turbo" and ok["settings"] == {"steps": 8, "sigmas": [1.0, 0.0]}
    with pytest.raises(paint.PaintError, match="at most 10"):
        paint.validate_paint_input({**base, "backend": "comfy:qwen-image-2.1-turbo", "refs": [f"https://x/{i}.png" for i in range(11)]})
    with pytest.raises(paint.PaintError, match="backend must be"):
        paint.validate_paint_input({**base, "backend": "comfy:../../etc"})


def test_the_manifest_matches_the_workflow():
    graph = {k: v for k, v in GRAPH.items() if not k.startswith("_")}
    for key in ("prompt", "negative", "resolution", "width", "height", "seed", "sampler", "sigmas", "cfg"):
        node, field = MANIFEST[key]
        assert field in graph[node]["inputs"], key
    assert all(graph[n]["class_type"] == "LoadImage" for n in MANIFEST["image_loaders"])
    enc = graph[MANIFEST["image_target"]]["inputs"]
    assert [enc[f"images.image_{i + 1}"][0] for i in range(10)] == MANIFEST["image_loaders"]
    assert graph[MANIFEST["output_node"]]["class_type"] == "SaveImage"


def test_the_base_model_samples_with_the_loras_settings_and_chains_the_lora(tmp_path, weights, monkeypatch):
    monkeypatch.setenv("LORA_DIR", str(tmp_path / "loras"))
    comfy = FakeComfy(graph=BASE_GRAPH, loras=[OMNI])
    hf = f"https://huggingface.co/chatrlabs/Qwen-Image-2.1-Uncensored-Omni-LoRA-v0.1/blob/main/{OMNI}"
    settings = paint._settings({"steps": 35, "cfg": 5, "sampler": "euler", "scheduler": "simple", "resolution": 1024, "seed": 3, "loras": [{"file": OMNI, "strength": 1, "hf_url": hf}]})
    paint.run_comfy("qwen-image-2.1", "<image1> in a red dress", pictures(tmp_path, 2), 1024, 1024, settings, comfy)
    # fetched once from HuggingFace (a blob link becomes a resolve link) into models/loras
    assert comfy.downloads == [hf.replace("/blob/", "/resolve/")] and (tmp_path / "loras" / OMNI).is_file()
    g = comfy.queued[0]
    assert g["lora1"]["class_type"] == "LoraLoaderModelOnly" and g["lora1"]["inputs"]["model"] == ["1", 0] and g["lora1"]["inputs"]["lora_name"] == OMNI
    assert g["4"]["inputs"]["model"] == ["lora1", 0]
    k = g["29"]["inputs"]
    assert (k["steps"], k["cfg"], k["sampler_name"], k["scheduler"], k["seed"]) == (35, 5.0, "euler", "simple", 3)
    # true CFG needs a negative: a single space, as the card says
    assert g["20"]["inputs"]["negative_prompt"] == " "
    # a second job finds the file and downloads nothing
    paint.run_comfy("qwen-image-2.1", "again", pictures(tmp_path, 1), 1024, 1024, settings, comfy)
    assert len(comfy.downloads) == 1


def test_lora_settings_are_sanitised():
    out = paint._settings({"loras": [
        {"file": OMNI, "strength": 0.8, "hf_url": "https://huggingface.co/x/y/resolve/main/a.safetensors"},
        {"file": "../../etc/passwd.safetensors"},
        {"file": "evil.safetensors", "hf_url": "https://evil.example/a.safetensors"},
        {"file": "notweights.bin"},
    ]})
    assert out["loras"] == [{"file": OMNI, "strength": 0.8, "hf_url": "https://huggingface.co/x/y/resolve/main/a.safetensors"}, {"file": "evil.safetensors", "strength": 1.0}]


def test_a_lora_without_a_link_or_file_fails_clearly(tmp_path, weights, monkeypatch):
    monkeypatch.setenv("LORA_DIR", str(tmp_path / "loras"))
    with pytest.raises(paint.PaintError, match="no HuggingFace link"):
        paint.run_comfy("qwen-image-2.1", "a prompt", pictures(tmp_path, 1), 1024, 1024, {"loras": [{"file": "x.safetensors", "strength": 1}]}, FakeComfy(graph=BASE_GRAPH))


def test_the_base_manifest_matches_its_workflow():
    entry = MANIFESTS["qwen-image-2.1"]
    graph = {k: v for k, v in BASE_GRAPH.items() if not k.startswith("_")}
    for key in ("prompt", "negative", "resolution", "width", "height", "seed", "steps", "sampler", "scheduler", "cfg"):
        node, field = entry[key]
        assert field in graph[node]["inputs"], key
    assert graph[entry["lora_after"]]["class_type"] == "UNETLoader" and entry["lora_into"] == ["4", "model"]
    assert graph[entry["output_node"]]["class_type"] == "SaveImage"

