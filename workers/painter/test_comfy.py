"""Image models on the GPU pod (paint.py run_comfy): the painter advertises
a model only when ComfyUI answers and its weights are on disk; a job fills
the model's API graph (reference slots in order, unused ones dropped, the
Studio's settings), checks the graph against this ComfyUI first, and comes
back as one picture."""

from __future__ import annotations

import io
import json
import os
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


def whole(path: Path, line: str) -> None:
    """A model file of the list's size (sparse: no disk used)."""
    size = int(line.split("\t")[2])
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        fh.truncate(size)


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

    def raise_for_status(self):
        if not self.ok:
            raise AssertionError(self.status_code)

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
        subdir, url = line.split("\t")[:2]
        whole(tmp_path / subdir / url.rsplit("/", 1)[-1], line)
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
            subdir, url = line.split("\t")[:2]
            # diffusion_models and unet are one folder type to ComfyUI
            whole(tmp_path / ("unet" if subdir == "diffusion_models" else subdir) / url.rsplit("/", 1)[-1], line)
    assert paint.comfy_backends(FakeComfy()) == ["comfy:qwen-image-2.1-turbo"]
    # a cut-off file is not the model
    vae = next(tmp_path.glob("vae/*.safetensors"))
    with open(vae, "r+b") as fh:
        fh.truncate(vae.stat().st_size - 1)
    assert paint.comfy_backends(FakeComfy()) == []
    with open(vae, "r+b") as fh:
        fh.truncate(vae.stat().st_size + 1)
    # while the pod downloads, it holds its models: a picture would crawl
    state = tmp_path / "dl"
    state.mkdir()
    (state / "chain.pid").write_text(str(os.getpid()))
    monkeypatch.setenv("DOWNLOAD_STATE_DIR", str(state))
    assert paint.comfy_backends(FakeComfy()) == []
    (state / "chain.pid").write_text("999999")
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


def test_text_to_image_drops_every_picture_slot(tmp_path, weights):
    """Canvas text to image: no picture, every loader and image input goes; the prompt alone steers."""
    comfy = FakeComfy()
    img = paint.run_comfy("qwen-image-2.1-turbo", "a rooftop after rain, neon in the puddles", [], 1024, 1536, {}, comfy)
    assert img.size == (1024, 1536)
    g = comfy.queued[0]
    assert not any(n in g for n in ("31", "32", "33", "34", "35", "36", "37", "38", "39", "40"))
    assert not [k for k in g["20"]["inputs"] if k.startswith("images.")]
    assert comfy.uploads == []
    assert g["20"]["inputs"]["prompt"] == "a rooftop after rain, neon in the puddles"


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



# ---------- Qwen-Image-Edit 2509 (anhao/ai-pose-gallery-zh's workflow) ----------

QIE = MANIFESTS["qwen-image-edit-2509"]
QIE3 = json.loads((POD / "workflows" / "QIE2509_3IMG.json").read_text())
QIE2 = json.loads((POD / "workflows" / "QIE2509_2IMG.json").read_text())
LIGHTNING = "Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors"


@pytest.fixture
def weights2509(tmp_path, monkeypatch):
    for line in (POD / QIE["files"]).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        subdir, url = line.split("\t")[:2]
        whole(tmp_path / subdir / url.rsplit("/", 1)[-1], line)
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    monkeypatch.setattr(paint, "COMFY_POLL_S", 0)
    return tmp_path


def comfy2509(graph):
    return FakeComfy(graph=graph, loras=[LIGHTNING])


SETTINGS_2509 = paint._settings({"steps": 4, "cfg": 1, "sampler": "euler", "scheduler": "simple", "seed": 11})


def test_2509_three_pictures_fill_portrait_costume_pose(tmp_path, weights2509):
    comfy = comfy2509(QIE3)
    paint.run_comfy("qwen-image-edit-2509", "图1的人物穿上图2的服装，按图3摆姿势", pictures(tmp_path, 3), 1024, 1536, SETTINGS_2509, comfy)
    g = comfy.queued[0]
    assert [g[n]["inputs"]["image"] for n in ("1", "2", "3")] == ["studio/ref0.png", "studio/ref1.png", "studio/ref2.png"]
    assert g["12"]["inputs"]["prompt"].startswith("图1的人物") and g["13"]["inputs"]["prompt"] == ""
    # the canvas is the original's: the pose picture's aspect at 1 MP, whatever size was asked
    assert g["10"]["class_type"] == "ImageScaleToTotalPixels" and g["10"]["inputs"]["image"] == ["3", 0] and g["10"]["inputs"]["megapixels"] == 1.0
    assert "width" not in g["10"]["inputs"] and g["11"]["inputs"]["pixels"] == ["10", 0]
    k = g["14"]["inputs"]
    assert (k["steps"], k["cfg"], k["sampler_name"], k["scheduler"], k["seed"], k["denoise"]) == (4, 1.0, "euler", "simple", 11, 1.0)
    # portrait and costume are pixel references; the pose only reaches the text encoder
    assert k["positive"] == ["25", 0] and g["25"]["inputs"]["conditioning"] == ["24", 0]
    assert g["5"]["inputs"]["lora_name"] == LIGHTNING and g["6"]["inputs"]["shift"] == 3.0


def test_2509_two_pictures_use_the_person_and_pose_graph(tmp_path, weights2509):
    comfy = comfy2509(QIE3)
    paint.run_comfy("qwen-image-edit-2509", "图1的人物按图2摆姿势", pictures(tmp_path, 2), 1008, 1344, SETTINGS_2509, comfy)
    g = comfy.queued[0]
    assert "2" not in g and "22" not in g and "25" not in g
    assert g["1"]["inputs"]["image"] == "studio/ref0.png" and g["3"]["inputs"]["image"] == "studio/ref1.png"
    assert g["12"]["inputs"]["image2"] == ["3", 0] and "image3" not in g["12"]["inputs"]
    assert g["14"]["inputs"]["positive"] == ["24", 0] and g["14"]["inputs"]["negative"] == ["26", 0]


def test_2509_needs_two_or_three_pictures(tmp_path, weights2509):
    with pytest.raises(paint.PaintError, match="at least 2"):
        paint.run_comfy("qwen-image-edit-2509", "a prompt", pictures(tmp_path, 1), 1024, 1024, {}, comfy2509(QIE3))
    with pytest.raises(paint.PaintError, match="at most 3"):
        paint.run_comfy("qwen-image-edit-2509", "a prompt", pictures(tmp_path, 4), 1024, 1024, {}, comfy2509(QIE3))


def test_2509_manifest_matches_both_graphs():
    for count, graph in (("3", QIE3), ("2", QIE2)):
        entry = {**QIE, **QIE.get("variants", {}).get(count, {})}
        assert entry["workflow"] == ("QIE2509_3IMG" if count == "3" else "QIE2509_2IMG")
        g = {k: v for k, v in graph.items() if not k.startswith("_")}
        for key in ("prompt", "negative", "seed", "steps", "sampler", "scheduler", "cfg"):
            node, field = entry[key]
            assert field in g[node]["inputs"], (count, key)
        # the canvas follows the pose picture, as in the original: no size from the Studio
        assert entry["width"] is None and entry["height"] is None and g["10"]["class_type"] == "ImageScaleToTotalPixels"
        assert len(entry["image_loaders"]) == int(count) and all(g[n]["class_type"] == "LoadImage" for n in entry["image_loaders"])
        assert g[entry["output_node"]]["class_type"] == "SaveImage"
        assert g[entry["lora_after"]]["class_type"] == "LoraLoaderModelOnly" and entry["lora_into"][0] in g
        for nid, node in g.items():
            for value in node["inputs"].values():
                if isinstance(value, list):
                    assert value[0] in g, (count, nid, value)


# ---------- a flipped pose ----------


def test_mirror_refs_are_validated():
    base = {"op": "paint", "prompt": "a picture", "size": "1024x1536", "output": {"key": "projects/p/images/j.png"}, "refs": ["https://x/a.png", "https://x/b.png"]}
    assert paint.validate_paint_input({**base, "mirror_refs": [1, 1]})["mirror_refs"] == [1]
    assert paint.validate_paint_input(base)["mirror_refs"] == []
    for bad in ([2], [-1], ["1"], [True], "1"):
        with pytest.raises(paint.PaintError, match="mirror_refs"):
            paint.validate_paint_input({**base, "mirror_refs": bad})


def test_a_flipped_reference_reaches_the_model_mirrored(tmp_path, monkeypatch):
    half = Image.new("RGB", (40, 20), (255, 0, 0))
    half.paste((0, 0, 255), (20, 0, 40, 20))
    buf = io.BytesIO()
    half.save(buf, "PNG")

    class Http:
        def get(self, url, stream=False, timeout=0, **kw):
            return Res(content=buf.getvalue())

    seen = []

    def draw(params, prompt, pics, has_base, workdir, http, runner, tag):
        seen.extend(Image.open(p).convert("RGB") for p in pics)
        img = Image.new("RGB", params["size"], (128, 128, 128))
        return img, 1, img.size

    class Up:
        def upload(self, path, key, ctype):
            return f"https://r2/{key}"

    monkeypatch.setattr(paint, "_draw", draw)
    params = paint.validate_paint_input({"op": "paint", "prompt": "a picture", "size": "64x64", "backend": "api", "output": {"key": "projects/p/images/j.png"}, "refs": ["https://x/a.png", "https://x/b.png"], "mirror_refs": [1]})
    paint.run_paint_job(params, Up(), tmp_path, http=Http())
    assert seen[0].getpixel((0, 0)) == (255, 0, 0)  # as drawn
    assert seen[1].getpixel((0, 0)) == (0, 0, 255)  # flipped left to right
