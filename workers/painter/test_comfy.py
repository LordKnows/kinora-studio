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
# MiniMax-H3-Image (open weights; Comfy-Org's templates without the prompt enhancer)
H3I = MANIFESTS["minimax-h3-image"]
H3I_GRAPH = json.loads((POD / "workflows" / "H3_IMAGE.json").read_text())
H3I_SETTINGS = {"steps": 6, "cfg": 1, "sampler": "euler", "scheduler": "simple", "resolution": 2048, "seed": 11}
LORA = "studio-look-v1.safetensors"


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
        self.info = object_info({k: v for k, v in (graph or H3I_GRAPH).items() if not k.startswith("_")})
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


class ComfyH3Image(FakeComfy):
    """Answers with a picture of the canvas the job asked for, from the graph's own SaveImage node."""

    def __init__(self, **kw):
        super().__init__(graph=H3I_GRAPH, **kw)

    def get(self, url, params=None, timeout=0, stream=False, headers=None):
        if "/history/" in url:
            pid = url.rsplit("/", 1)[-1]
            return Res(payload={pid: {"status": {"status_str": "success"}, "outputs": {"9": {"images": [{"filename": "h3_image_00001_.png", "subfolder": "studio", "type": "output"}]}}}})
        if url.endswith("/view"):
            cond = self.queued[-1]["5"]["inputs"]
            return Res(content=png((30, 160, 90), (cond["width"], cond["height"])))
        return super().get(url, params=params, timeout=timeout, stream=stream, headers=headers)


@pytest.fixture
def weights_h3_image(tmp_path, monkeypatch):
    for line in (POD / H3I["files"]).read_text().splitlines():
        if line.strip() and not line.startswith("#"):
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
    for line in (POD / H3I["files"]).read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            subdir, url = line.split("\t")[:2]
            # diffusion_models and unet are one folder type to ComfyUI
            whole(tmp_path / ("unet" if subdir == "diffusion_models" else subdir) / url.rsplit("/", 1)[-1], line)
    assert paint.comfy_backends(FakeComfy()) == ["comfy:minimax-h3-image"]
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
    assert paint.comfy_backends(FakeComfy()) == ["comfy:minimax-h3-image"]

    class Down(FakeComfy):
        def get(self, url, **kw):
            raise paint.requests.ConnectionError("no comfy")

    assert paint.comfy_backends(Down()) == []


def test_a_job_fills_the_graph_in_order_and_drops_unused_slots(tmp_path, weights_h3_image):
    comfy = ComfyH3Image()
    settings = paint._settings({"steps": 6, "cfg": 1, "sampler": "euler", "scheduler": "simple", "resolution": 2048, "seed": 7, "junk": 1})
    img = paint.run_comfy("minimax-h3-image", "<Picture 1> wears <Picture 2>", pictures(tmp_path, 3), 1000, 1500, settings, comfy)
    g = comfy.queued[0]
    cond = g["5"]["inputs"]
    assert cond["prompt"] == "<Picture 1> wears <Picture 2>"
    assert [k for k in cond if k.startswith("images.")] == ["images.image_1", "images.image_2", "images.image_3"]
    assert "34" not in g and "33" in g
    assert [g[n]["inputs"]["image"] for n in ("31", "32", "33")] == ["studio/ref0.png", "studio/ref1.png", "studio/ref2.png"]
    # the canvas is on the model's 32-pixel grid, at its working area, and comes back as drawn
    assert cond["width"] % 32 == 0 and cond["height"] % 32 == 0 and img.size == (cond["width"], cond["height"])
    k = g["7"]["inputs"]
    assert (k["seed"], k["cfg"], k["steps"], k["sampler_name"], k["scheduler"]) == (7, 1.0, 6, "euler", "simple")


def test_the_preflight_names_what_this_comfyui_lacks(tmp_path, weights_h3_image):
    with pytest.raises(paint.PaintError, match="lacks the nodes MiniMaxH3ImageConditioning"):
        paint.run_comfy("minimax-h3-image", "a prompt", pictures(tmp_path, 1), 1024, 1024, {}, ComfyH3Image(missing_node="MiniMaxH3ImageConditioning"))
    with pytest.raises(paint.PaintError, match="unet_name = minimax_h3_image_pruned_int8_convrot.safetensors is not in this ComfyUI"):
        paint.run_comfy("minimax-h3-image", "a prompt", pictures(tmp_path, 1), 1024, 1024, {}, ComfyH3Image(missing_file=True))


def test_missing_weights_and_unknown_models_fail_clearly(tmp_path, monkeypatch):
    monkeypatch.setenv("MODELS_DIR", str(tmp_path))
    with pytest.raises(paint.PaintError, match="model files not on the pod yet"):
        paint.run_comfy("minimax-h3-image", "a prompt", [], 1024, 1024, {}, FakeComfy())
    with pytest.raises(paint.PaintError, match="no image model"):
        paint.run_comfy("nope", "a prompt", [], 1024, 1024, {}, FakeComfy())
    # a model the Studio retired is no longer on the pod's list
    for retired in ("qwen-image-2.1-turbo", "qwen-image-2.1", "qwen-image-edit-2509"):
        with pytest.raises(paint.PaintError, match="no image model"):
            paint.run_comfy(retired, "a prompt", [], 1024, 1024, {}, FakeComfy())


def test_validation_accepts_comfy_backends_with_up_to_ten_pictures():
    base = {"op": "paint", "prompt": "a picture", "size": "1024x1536", "output": {"key": "projects/p/images/j.png"}}
    ok = paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "refs": [f"https://x/{i}.png" for i in range(10)], "params": {"steps": 8, "sigmas": [1, 0]}})
    assert ok["backend"] == "comfy:minimax-h3-image" and ok["settings"] == {"steps": 8, "sigmas": [1.0, 0.0]}
    with pytest.raises(paint.PaintError, match="at most 10"):
        paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "refs": [f"https://x/{i}.png" for i in range(11)]})
    with pytest.raises(paint.PaintError, match="backend must be"):
        paint.validate_paint_input({**base, "backend": "comfy:../../etc"})


def test_a_jobs_lora_is_fetched_once_and_chained_after_the_model_loader(tmp_path, weights_h3_image, monkeypatch):
    monkeypatch.setenv("LORA_DIR", str(tmp_path / "loras"))
    comfy = ComfyH3Image(loras=[LORA])
    hf = f"https://huggingface.co/studio/looks/blob/main/{LORA}"
    settings = paint._settings({**H3I_SETTINGS, "seed": 3, "loras": [{"file": LORA, "strength": 0.8, "hf_url": hf}]})
    paint.run_comfy("minimax-h3-image", "<Picture 1> in a red dress", pictures(tmp_path, 2), 1024, 1024, settings, comfy)
    # fetched once from HuggingFace (a blob link becomes a resolve link) into models/loras
    assert comfy.downloads == [hf.replace("/blob/", "/resolve/")] and (tmp_path / "loras" / LORA).is_file()
    g = comfy.queued[0]
    assert g["lora1"]["class_type"] == "LoraLoaderModelOnly" and g["lora1"]["inputs"] == {"model": ["1", 0], "lora_name": LORA, "strength_model": 0.8}
    assert g["7"]["inputs"]["model"] == ["lora1", 0] and g["7"]["inputs"]["seed"] == 3
    # a second job finds the file and downloads nothing
    paint.run_comfy("minimax-h3-image", "again", pictures(tmp_path, 1), 1024, 1024, settings, comfy)
    assert len(comfy.downloads) == 1


def test_lora_settings_are_sanitised():
    out = paint._settings({"loras": [
        {"file": LORA, "strength": 0.8, "hf_url": "https://huggingface.co/x/y/resolve/main/a.safetensors"},
        {"file": "../../etc/passwd.safetensors"},
        {"file": "evil.safetensors", "hf_url": "https://evil.example/a.safetensors"},
        {"file": "notweights.bin"},
    ]})
    assert out["loras"] == [{"file": LORA, "strength": 0.8, "hf_url": "https://huggingface.co/x/y/resolve/main/a.safetensors"}, {"file": "evil.safetensors", "strength": 1.0}]


def test_a_lora_without_a_link_or_file_fails_clearly(tmp_path, weights_h3_image, monkeypatch):
    monkeypatch.setenv("LORA_DIR", str(tmp_path / "loras"))
    with pytest.raises(paint.PaintError, match="no HuggingFace link"):
        paint.run_comfy("minimax-h3-image", "a prompt", pictures(tmp_path, 1), 1024, 1024, {"loras": [{"file": "x.safetensors", "strength": 1}]}, ComfyH3Image())


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


# ---------- MiniMax-H3-Image: the manifest, the working canvas, text to image and edits ----------


def test_h3_image_shares_the_video_models_text_encoder():
    """The model uses the MiniMax-H3 text encoder unchanged: the same file the video graphs load, so it is on the pod once."""
    files = paint.model_files(H3I)
    assert [(d, n) for d, n, _ in files] == [
        ("diffusion_models", "minimax_h3_image_pruned_int8_convrot.safetensors"),
        ("text_encoders", "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
        ("vae", "minimax_h3_image_vae_fp16.safetensors")]
    core = [line.split("\t") for line in (POD / "models.txt").read_text().splitlines() if line.startswith("text_encoders")]
    mine = [line.split("\t") for line in (POD / H3I["files"]).read_text().splitlines() if line.startswith("text_encoders")]
    assert mine == core
    video = json.loads((POD / "workflows" / "T2VA.json").read_text())
    video_clip = next(n["inputs"] for n in video.values() if isinstance(n, dict) and n.get("class_type") == "CLIPLoader")
    assert H3I_GRAPH["2"]["inputs"] == video_clip


def test_the_h3_image_manifest_matches_its_workflow():
    graph = {k: v for k, v in H3I_GRAPH.items() if not k.startswith("_")}
    for key in ("prompt", "width", "height", "seed", "steps", "sampler", "scheduler", "cfg"):
        node, field = H3I[key]
        assert field in graph[node]["inputs"], key
    # no negative prompt (the model takes none: the negative is the positive zeroed) and no fixed sigma schedule
    assert H3I["negative"] is None and H3I["sigmas"] is None and H3I["resolution"] is None
    assert graph["7"]["inputs"]["negative"] == ["6", 0] and graph["6"]["class_type"] == "ConditioningZeroOut"
    assert all(graph[n]["class_type"] == "LoadImage" for n in H3I["image_loaders"])
    cond = graph[H3I["image_target"]]
    assert cond["class_type"] == "MiniMaxH3ImageConditioning"
    assert [cond["inputs"][f"images.image_{i + 1}"][0] for i in range(10)] == H3I["image_loaders"]
    # the distilled chain of the model card: 6 steps, no guidance
    k = graph["7"]["inputs"]
    assert (k["steps"], k["cfg"], k["sampler_name"], k["scheduler"], k["denoise"]) == (6, 1.0, "euler", "simple", 1.0)
    assert graph[H3I["lora_after"]]["class_type"] == "UNETLoader" and H3I["lora_into"] == ["7", "model"]
    assert graph[H3I["output_node"]]["class_type"] == "SaveImage"
    # every link points at a node the graph has
    for node in graph.values():
        for value in node["inputs"].values():
            if isinstance(value, list):
                assert value[0] in graph


def test_the_working_canvas_keeps_the_shape_at_four_megapixels():
    """Below its working range the model is weak: a small request is drawn larger, on its 32-pixel grid, in the same shape."""
    area = H3I["min_area"]
    assert area == 2048 * 2048
    for (w, h), want in {(1344, 768): (2688, 1536), (1024, 1024): (2048, 2048), (1024, 1536): (1664, 2496), (1536, 1024): (2496, 1664), (1008, 1344): (1824, 2432)}.items():
        cw, ch = paint.working_canvas(w, h, 32, area)
        assert (cw, ch) == want, (w, h)
        assert cw % 32 == 0 and ch % 32 == 0 and cw * ch >= 0.97 * area and abs(cw / ch - w / h) < 1e-9
    # an odd shape lands on the nearest grid size (under 1% off) rather than failing
    cw, ch = paint.working_canvas(1000, 700, 32, area)
    assert cw % 32 == 0 and ch % 32 == 0 and cw * ch >= 0.97 * area and abs(cw / ch - 1000 / 700) / (1000 / 700) < 0.01
    # a request inside the range is only put on the grid; a model without a range never scales
    assert paint.working_canvas(5472, 3072, 32, area) == (5472, 3072)
    assert paint.working_canvas(1000, 1500, 32) == (992, 1504)


def test_h3_image_text_to_image_draws_at_four_megapixels(tmp_path, weights_h3_image):
    comfy = ComfyH3Image()
    img = paint.run_comfy("minimax-h3-image", "a rooftop after rain, neon in the puddles", [], 1344, 768, paint._settings(H3I_SETTINGS), comfy)
    # the picture comes back at the working canvas; run_paint_job fits it to the asked 1344x768
    assert img.size == (2688, 1536)
    assert paint.cropped_share(img.size, 1344, 768)[0] == 0
    g = comfy.queued[0]
    cond = g["5"]["inputs"]
    assert cond["prompt"] == "a rooftop after rain, neon in the puddles" and (cond["width"], cond["height"]) == (2688, 1536)
    assert not [k for k in cond if k.startswith("images.")] and not any(str(n) in g for n in range(31, 41))
    assert "resolution" not in cond and comfy.uploads == []
    k = g["7"]["inputs"]
    assert (k["steps"], k["cfg"], k["sampler_name"], k["scheduler"], k["seed"]) == (6, 1.0, "euler", "simple", 11)


def test_h3_image_edits_from_pictures_in_order(tmp_path, weights_h3_image):
    comfy = ComfyH3Image()
    settings = paint._settings({**H3I_SETTINGS, "resolution": 4096})
    img = paint.run_comfy("minimax-h3-image", "<Picture 1> wears the coat of <Picture 2>", pictures(tmp_path, 2), 1024, 1024, settings, comfy)
    # resolution 4096: the 16 MP the model card recommends
    assert img.size == (4096, 4096)
    g = comfy.queued[0]
    cond = g["5"]["inputs"]
    assert [k for k in cond if k.startswith("images.")] == ["images.image_1", "images.image_2"]
    assert [g[n]["inputs"]["image"] for n in ("31", "32")] == ["studio/ref0.png", "studio/ref1.png"] and "33" not in g
    assert cond["prompt"] == "<Picture 1> wears the coat of <Picture 2>"


def test_h3_image_is_advertised_and_refused_like_the_other_pod_models(tmp_path, weights_h3_image):
    assert paint.comfy_backends(ComfyH3Image()) == ["comfy:minimax-h3-image"]
    with pytest.raises(paint.PaintError, match="lacks the nodes MiniMaxH3ImageConditioning.*MiniMax-H3-Image needs ComfyUI v0.45.0"):
        paint.run_comfy("minimax-h3-image", "a prompt", [], 1024, 1024, {}, ComfyH3Image(missing_node="MiniMaxH3ImageConditioning"))
    with pytest.raises(paint.PaintError, match="at most 10"):
        paint.run_comfy("minimax-h3-image", "a prompt", pictures(tmp_path, 11), 1024, 1024, {}, ComfyH3Image())
    (weights_h3_image / "vae" / "minimax_h3_image_vae_fp16.safetensors").unlink()
    with pytest.raises(paint.PaintError, match="model files not on the pod yet .*H3_IMAGE=1"):
        paint.run_comfy("minimax-h3-image", "a prompt", [], 1024, 1024, {}, ComfyH3Image())


# ---------- a picture delivered at the model's own resolution (Canvas → Resolution: 4, 9, 16 MP) ----------

# src/studio/canvas-prompt.ts canvasOutputSize: the Studio's shapes at each resolution (tests/models.test.ts holds the same table)
DELIVERED = {
    2048: {"1024x1536": "1664x2496", "1008x1344": "1824x2432", "1024x1024": "2048x2048", "1536x1024": "2496x1664", "1344x768": "2688x1536"},
    3072: {"1024x1536": "2496x3744", "1008x1344": "2688x3584", "1024x1024": "3072x3072", "1536x1024": "3744x2496", "1344x768": "4032x2304"},
    4096: {"1024x1536": "3328x4992", "1008x1344": "3552x4736", "1024x1024": "4096x4096", "1536x1024": "4992x3328", "1344x768": "5376x3072"},
}


def test_a_delivered_size_is_the_canvas_the_model_draws_on():
    """The Studio asks for the size it computed; the painter draws exactly that, at the model's default 4 MP floor or the job's own."""
    for side, table in DELIVERED.items():
        for shape, size in table.items():
            w, h = (int(v) for v in shape.split("x"))
            cw, ch = (int(v) for v in size.split("x"))
            # the same search from the Studio shape lands on it
            assert paint.working_canvas(w, h, 32, side * side) == (cw, ch), (side, shape)
            # and asked for directly it is kept: never scaled again, whatever the floor
            assert paint.working_canvas(cw, ch, 32, H3I["min_area"]) == (cw, ch)
            assert paint.working_canvas(cw, ch, 32, side * side) == (cw, ch)
            assert paint.parse_size(size, large=True) == (cw, ch)


def test_h3_image_draws_sixteen_megapixels_as_asked(tmp_path, weights_h3_image):
    comfy = ComfyH3Image()
    img = paint.run_comfy("minimax-h3-image", "a rooftop after rain, neon in the puddles", [], 5376, 3072, paint._settings(H3I_SETTINGS), comfy)
    cond = comfy.queued[0]["5"]["inputs"]
    assert (cond["width"], cond["height"]) == (5376, 3072) and img.size == (5376, 3072)
    # nothing is cut or resized when the job fits it to its size
    assert paint.cropped_share(img.size, 5376, 3072)[0] == 0 and paint.fit(img, 5376, 3072).size == (5376, 3072)


def test_only_a_pod_model_may_be_asked_for_a_large_picture():
    base = {"op": "paint", "prompt": "a picture", "output": {"key": "projects/p/images/j.png"}}
    assert paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "size": "5376x3072"})["size"] == (5376, 3072)
    assert paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "size": "6272x2688"})["size"] == (6272, 2688)
    for backend in ("codex", "api", "qwen"):
        with pytest.raises(paint.PaintError, match="between 64 and 4096"):
            paint.validate_paint_input({**base, "backend": backend, "size": "5376x3072"})
    with pytest.raises(paint.PaintError, match="at most 21 MP"):
        paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "size": "6400x6400"})
    with pytest.raises(paint.PaintError, match="6400 pixels per side"):
        paint.validate_paint_input({**base, "backend": "comfy:minimax-h3-image", "size": "8192x2048"})
    # crops and extracts stay within the Studio's sizes
    with pytest.raises(paint.PaintError, match="between 64 and 4096"):
        paint.validate_paint_input({"op": "crop", "output": {"key": "projects/p/images/j.png"}, "base": "https://x/b.png", "crop": {"x": 0, "y": 0, "w": 1, "h": 1}, "size": "5376x3072", "backend": "comfy:minimax-h3-image"})


def test_a_large_reference_is_scaled_down_and_a_base_picture_is_not(tmp_path):
    """A 16 MP picture used as a reference goes on at 4096 px: no model reads more. The picture being edited keeps its pixels."""

    class Http:
        def get(self, url, stream=False, timeout=0):
            return Res(content=png((90, 90, 90), (5376, 3072)))

    ref = paint._download_picture("https://x/big.png", tmp_path / "ref0", Http(), max_side=paint.REF_MAX_SIDE)
    assert Image.open(ref).size == (4096, 2341)
    base = paint._download_picture("https://x/big.png", tmp_path / "base", Http())
    assert Image.open(base).size == (5376, 3072)
    small = paint._download_picture("https://x/small.png", tmp_path / "ref1", type("H", (), {"get": lambda self, url, stream=False, timeout=0: Res(content=png((1, 2, 3), (1024, 1536)))})(), max_side=paint.REF_MAX_SIDE)
    assert Image.open(small).size == (1024, 1536)


def test_the_whole_job_delivers_the_resolution_asked_for(tmp_path, weights_h3_image):
    """Through the painter's job: a 16 MP request is saved at 16 MP; a Studio size is drawn at 4 MP and saved at the Studio size."""
    saved = {}

    class Up:
        def upload(self, path, key, ctype):
            if key.endswith(".png"):
                saved[key] = Image.open(path).size
            return f"https://studio.example/media/{key}"

    for name, size, want in (("big", "5376x3072", (5376, 3072)), ("std", "1344x768", (1344, 768))):
        comfy = ComfyH3Image()
        params = paint.validate_paint_input({"op": "paint", "backend": "comfy:minimax-h3-image", "prompt": "a harbour at dawn, fishing boats", "size": size,
                                             "output": {"key": f"projects/p/images/{name}.png"}, "params": H3I_SETTINGS, "check": {"review": False, "redraws": 0}})
        work = tmp_path / name
        work.mkdir()
        out = paint.run_paint_job(params, Up(), work, http=comfy)
        assert (out["width"], out["height"]) == want and saved[f"projects/p/images/{name}.png"] == want
        # nothing was cut to fit: the canvas had the picture's shape
        assert not [c for c in out.get("checks", []) if c["id"] == "cropped"]
    assert (comfy.queued[0]["5"]["inputs"]["width"], comfy.queued[0]["5"]["inputs"]["height"]) == (2688, 1536)
