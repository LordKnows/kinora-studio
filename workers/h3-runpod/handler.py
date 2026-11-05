"""RunPod serverless handler for MiniMax H3 on ComfyUI.

Input (from the Studio's compiler, `WorkerInput`):
    workflow   T2VA | I2VA | FL2VA | R2VA
    prompt, negative, seconds, video_size "WxH", steps, seed?, enhance
    images     [{url, role: first_frame|last_frame|reference, label?}]
    video?     url of a source clip (R2VA edit)
    output     {key}  — R2 key of the mp4; siblings derive from it
    studio_take_id

Output (posted to the Studio webhook by RunPod):
    {url, last_frame_url, thumb_urls[4], execution_ms, seed}

The ComfyUI graph itself is not in this repo: the deployer drops API-format
workflow JSONs into workflows/ and points mapping.json at the right nodes.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Any

import requests

WORKFLOWS = ("T2VA", "I2VA", "FL2VA", "R2VA")
# Open-H3-Regenerate-2K: a finished take re-generated at a higher resolution.
REGEN_WORKFLOW = "REGEN"
REGEN_RESOLUTIONS = {"768p": "768p (1344x768)", "1080p": "1080p (1920x1080)", "2k": "2k (2560x1440)", "4k": "4k (3840x2160)"}
REGEN_FILES = [("loras", "open_h3_regenerate_2k_lora.safetensors"), ("loras", "sharp_curve_branches.safetensors"), ("vae", "fast_h3_vae_noncausal_24l.safetensors"), ("latent_upscale_models", "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors")]
REGEN_NODE_DIR = os.environ.get("REGEN_NODE_DIR", "/workspace/runpod-slim/ComfyUI/custom_nodes/ComfyUI-Open-H3-Regenerate")
ROLES = ("first_frame", "last_frame", "reference")
HERE = Path(__file__).resolve().parent
WORKFLOW_DIR = Path(os.environ.get("WORKFLOW_DIR", HERE / "workflows"))
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
THUMB_COUNT = 4
THUMB_WIDTH = 320
FPS = 24
# The H3 node takes a frame count of the form 17k+5; the pruned turbo graphs
# were validated at 124 (≈5.2 s) and 243 (≈10.1 s); the node documents 124–362.
FRAME_MIN = 124
FRAME_MAX = 362
LORA_DIR = Path(os.environ.get("LORA_DIR", "/workspace/ComfyUI/models/loras"))
HF_TOKEN = os.environ.get("HF_TOKEN")


class JobError(Exception):
    """Anything the caller can fix: bad input, missing workflow, no output."""


# ---------- input ----------


def validate_input(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("input must be an object")
    workflow = raw.get("workflow")
    if workflow == REGEN_WORKFLOW:
        return validate_regen_input(raw)
    if workflow not in WORKFLOWS:
        raise JobError(f"workflow must be one of {', '.join(WORKFLOWS)}")
    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("prompt must be a non-empty string")
    seconds = raw.get("seconds")
    if not isinstance(seconds, (int, float)) or not 1 <= seconds <= 15:
        raise JobError("seconds must be a number between 1 and 15")
    width, height = parse_video_size(raw.get("video_size", "1344x768"))
    steps = raw.get("steps", 8)
    if not isinstance(steps, int) or not 1 <= steps <= 60:
        raise JobError("steps must be an integer between 1 and 60")
    sampling = raw.get("sampling")
    if sampling is not None:
        if not isinstance(sampling, dict):
            raise JobError("sampling must be an object {sampler?, scheduler?, shift_video?, shift_audio?}")
        for key in ("sampler", "scheduler"):
            if key in sampling and (not isinstance(sampling[key], str) or not re.fullmatch(r"[a-z0-9_]+", sampling[key])):
                raise JobError(f"sampling.{key} must be a ComfyUI sampler/scheduler name")
        for key in ("shift_video", "shift_audio"):
            if key in sampling and (not isinstance(sampling[key], (int, float)) or not 0.1 <= float(sampling[key]) <= 20):
                raise JobError(f"sampling.{key} must be a number between 0.1 and 20")
    seed = raw.get("seed")
    if seed is None:
        seed = int.from_bytes(os.urandom(4), "big")
    elif not isinstance(seed, int):
        raise JobError("seed must be an integer")
    images = raw.get("images", [])
    if not isinstance(images, list):
        raise JobError("images must be a list")
    for img in images:
        if not isinstance(img, dict) or not isinstance(img.get("url"), str) or img.get("role") not in ROLES:
            raise JobError("each image needs a url and a role of first_frame, last_frame or reference")
    roles = [img["role"] for img in images]
    if workflow in ("I2VA", "FL2VA") and roles.count("first_frame") != 1:
        raise JobError(f"{workflow} needs exactly one first_frame image")
    if workflow == "FL2VA" and roles.count("last_frame") != 1:
        raise JobError("FL2VA needs exactly one last_frame image")
    if workflow == "R2VA" and not roles.count("reference") and not raw.get("video"):
        raise JobError("R2VA needs at least one reference image or a source video")
    video = raw.get("video")
    if video is not None and not isinstance(video, str):
        raise JobError("video must be a url string")
    output = raw.get("output") or {}
    key = output.get("key") if isinstance(output, dict) else None
    if not isinstance(key, str) or not key.endswith(".mp4"):
        raise JobError("output.key must be an R2 key ending in .mp4")
    loras = raw.get("loras") or []
    if not isinstance(loras, list):
        raise JobError("loras must be a list")
    clean_loras = []
    for lora in loras:
        if not isinstance(lora, dict) or not isinstance(lora.get("file"), str) or not lora["file"]:
            raise JobError("each lora needs a file name")
        if "/" in lora["file"] or lora["file"].startswith("."):
            raise JobError("lora file must be a bare file name inside models/loras")
        strength = lora.get("strength", 1.0)
        if not isinstance(strength, (int, float)) or not 0 <= strength <= 2:
            raise JobError("lora strength must be between 0 and 2")
        hf_url = lora.get("hf_url")
        if hf_url is not None and not isinstance(hf_url, str):
            raise JobError("lora hf_url must be a string")
        clean_loras.append({"file": lora["file"], "strength": float(strength), "hf_url": hf_url, "name": lora.get("name", lora["file"])})
    return {
        "workflow": workflow,
        "prompt": prompt,
        "negative": str(raw.get("negative") or ""),
        "seconds": float(seconds),
        "width": width,
        "height": height,
        "steps": steps,
        "sampling": sampling,
        "seed": seed,
        "enhance": bool(raw.get("enhance", False)),
        "images": images,
        "video": video,
        "output_key": key,
        "studio_take_id": raw.get("studio_take_id"),
        "loras": clean_loras,
    }


def seconds_to_frames(seconds: float) -> int:
    """Nearest valid H3 length (17k+5 frames at 24 fps), clamped to the model's range."""
    target = seconds * FPS
    k = max(0, round((target - 5) / 17))
    frames = 17 * k + 5
    return max(FRAME_MIN, min(FRAME_MAX, frames))


def parse_video_size(value: Any) -> tuple[int, int]:
    if not isinstance(value, str) or "x" not in value:
        raise JobError('video_size must look like "1344x768"')
    w, h = value.lower().split("x", 1)
    if not (w.isdigit() and h.isdigit()):
        raise JobError('video_size must look like "1344x768"')
    return int(w), int(h)


def derive_keys(video_key: str) -> dict[str, Any]:
    stem = video_key[: -len(".mp4")]
    return {
        "video": video_key,
        "last_frame": f"{stem}.last.png",
        "thumbs": [f"{stem}.thumbs/{i}.jpg" for i in range(THUMB_COUNT)],
    }


# ---------- workflow templates ----------


def load_mapping(path: Path | None = None) -> dict[str, Any]:
    with open(path or WORKFLOW_DIR / "mapping.json", encoding="utf-8") as fh:
        return json.load(fh)


def load_workflow(name: str, directory: Path | None = None) -> dict[str, Any]:
    path = (directory or WORKFLOW_DIR) / f"{name}.json"
    if not path.exists():
        raise JobError(f"workflow template {path.name} is missing; see workflows/README.md")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def fill_graph(graph: dict[str, Any], mapping: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    """Write the job's values into the API-format graph by node id / input name.

    `mapping` is one entry of mapping.json: {"field": ["node_id", "input"], ...}.
    Scalar fields are set when mapped; reference_images is a list of targets.
    """
    graph = json.loads(json.dumps(graph))

    def put(target: Any, value: Any, required: bool, field: str) -> None:
        if not target:
            if required:
                raise JobError(f"mapping has no target for required field {field}")
            return
        node_id, input_name = target
        node = graph.get(str(node_id))
        if node is None:
            raise JobError(f"mapping points {field} at node {node_id}, which is not in the graph")
        node.setdefault("inputs", {})[input_name] = value

    put(mapping.get("prompt"), params["prompt"], True, "prompt")
    put(mapping.get("negative"), params["negative"], False, "negative")
    if mapping.get("length"):
        put(mapping.get("length"), seconds_to_frames(params["seconds"]), True, "length")
    else:
        put(mapping.get("seconds"), params["seconds"], True, "seconds")
    put(mapping.get("width"), params["width"], False, "width")
    put(mapping.get("height"), params["height"], False, "height")
    put(mapping.get("steps"), params["steps"], False, "steps")
    put(mapping.get("seed"), params["seed"], False, "seed")
    sampling = params.get("sampling") or {}
    if sampling:
        if "sampler" in sampling:
            put(mapping.get("sampler"), sampling["sampler"], True, "sampler")
        if "scheduler" in sampling:
            put(mapping.get("scheduler"), sampling["scheduler"], True, "scheduler")
        shift = mapping.get("shift")
        if ("shift_video" in sampling or "shift_audio" in sampling):
            if not shift:
                raise JobError("mapping.json has no shift node for this workflow")
            if "shift_video" in sampling:
                put((shift["node"], shift["video"]), float(sampling["shift_video"]), True, "shift")
            if "shift_audio" in sampling:
                put((shift["node"], shift["audio"]), float(sampling["shift_audio"]), True, "shift")
    put(mapping.get("enhance"), params["enhance"], False, "enhance")

    files = params.get("files", {})
    if "first_frame" in files:
        put(mapping.get("first_frame"), files["first_frame"], True, "first_frame")
    if "last_frame" in files:
        put(mapping.get("last_frame"), files["last_frame"], True, "last_frame")
    refs = files.get("reference", [])
    targets = list(mapping.get("reference_images", []))
    extra = mapping.get("reference_extra")
    if len(refs) > len(targets):
        # Grow the graph: clone the first LoadImage slot for every reference
        # beyond the template's and wire it into the H3 node's next ref slot
        # (inputs are flat keys like "ref_images.ref_image_2"; the node takes 0–8).
        if not extra:
            raise JobError(f"workflow accepts {len(targets)} reference images, got {len(refs)}")
        if len(refs) > int(extra.get("max", 9)):
            raise JobError(f"H3 takes at most {extra.get('max', 9)} reference images, got {len(refs)}")
        proto = graph.get(str(extra["clone_node"]))
        if proto is None:
            raise JobError("reference_extra.clone_node is not in the graph")
        for i in range(len(targets), len(refs)):
            node_id = f"{extra['clone_node']}_ref{i}"
            graph[node_id] = json.loads(json.dumps(proto))
            graph[node_id].setdefault("_meta", {})["title"] = f"Reference Image {i}"
            graph[str(extra["target_node"])]["inputs"][extra["input_pattern"].format(i=i)] = [node_id, 0]
            targets.append([node_id, "image"])
    for target, name in zip(targets, refs):
        put(target, name, True, "reference_images")
    # Fewer references than the template has slots: the spare LoadImage nodes
    # still carry the handoff's placeholder names (ref_1.png…), which ComfyUI
    # rejects at validation. Unwire and drop them; the H3 node takes 0–8
    # ref_images.ref_image_N keys, so a missing key is simply "no image".
    if len(refs) < len(targets):
        target_node = str(extra["target_node"]) if extra else None
        for i in range(len(refs), len(targets)):
            node_id = str(targets[i][0])
            if target_node and target_node in graph:
                for key, value in list(graph[target_node]["inputs"].items()):
                    if isinstance(value, list) and value and str(value[0]) == node_id:
                        del graph[target_node]["inputs"][key]
            else:
                for other in graph.values():
                    for key, value in list(other.get("inputs", {}).items()):
                        if isinstance(value, list) and value and str(value[0]) == node_id:
                            del other["inputs"][key]
            graph.pop(node_id, None)
    if files.get("video"):
        put(mapping.get("video"), files["video"], True, "video")

    # LoRA slots: [{"node": "12", "name": "lora_name", "strength": "strength_model", "strength_clip": "strength_clip"}, ...]
    slots = mapping.get("loras", [])
    loras = params.get("loras", [])
    if len(loras) > len(slots):
        if not slots:
            raise JobError("this workflow has no LoRA slots in mapping.json but the job asks for LoRAs")
        raise JobError(f"workflow has {len(slots)} LoRA slot(s), got {len(loras)}")
    if "loras" in params:
        for i, slot in enumerate(slots):
            node_id = slot.get("node")
            if i < len(loras):
                put((node_id, slot.get("name", "lora_name")), loras[i]["file"], True, "loras")
                put((node_id, slot.get("strength", "strength_model")), loras[i]["strength"], True, "loras")
                if slot.get("strength_clip"):
                    put((node_id, slot["strength_clip"]), loras[i]["strength"], False, "loras")
            else:
                # unused slot: neutralise it rather than leaving the template's default LoRA on
                put((node_id, slot.get("strength", "strength_model")), 0.0, False, "loras")
                if slot.get("strength_clip"):
                    put((node_id, slot["strength_clip"]), 0.0, False, "loras")
    return graph


# ---------- LoRA files ----------


def hf_resolve_url(url: str) -> str:
    """Turn a HuggingFace 'blob' page link into the direct file URL."""
    return url.replace("/blob/", "/resolve/", 1) if "/blob/" in url else url


def hf_repo_of(url: str) -> str | None:
    """'https://huggingface.co/owner/repo[/tree/main...]' → 'owner/repo'; a
    direct file link (blob/resolve) → None."""
    m = re.match(r"https?://(?:www\.)?huggingface\.co/([^/\s]+/[^/\s]+)(?:/(?:tree)/[^\s]*)?/?$", url.strip())
    return m.group(1) if m and "/blob/" not in url and "/resolve/" not in url else None


def hf_pick_file(repo: str, wanted: str, http: Any, headers: dict[str, str]) -> tuple[str, str]:
    """Choose the weight file in a repo: the one named like `wanted` when it
    exists, else a ComfyUI-flavoured one, else the most-trained / largest
    .safetensors. Returns (filename in repo, direct URL)."""
    res = http.get(f"https://huggingface.co/api/models/{repo}?blobs=true", timeout=60, headers=headers)
    if res.status_code >= 400:
        raise JobError(f"could not list HuggingFace repo {repo} ({res.status_code})")
    info = res.json()
    files = [(s.get("rfilename", ""), int(s.get("size") or 0)) for s in info.get("siblings", [])]
    weights = [(n, sz) for n, sz in files if n.lower().endswith(".safetensors")]
    if not weights:
        raise JobError(f"HuggingFace repo {repo} has no .safetensors file")
    exact = [w for w in weights if w[0].rsplit("/", 1)[-1] == wanted]
    if exact:
        chosen = exact[0]
    else:
        def rank(w: tuple[str, int]) -> tuple[int, int, int]:
            name = w[0].lower()
            steps = max([int(x) for x in re.findall(r"(\d{3,6})", name)] or [0])
            return (1 if "comfy" in name else 0, steps, w[1])
        chosen = sorted(weights, key=rank, reverse=True)[0]
    return chosen[0], f"https://huggingface.co/{repo}/resolve/main/{chosen[0]}"


def ensure_loras(loras: list[dict[str, Any]], lora_dir: Path | None = None, session: requests.Session | None = None) -> list[Path]:
    """Make sure every LoRA file exists in the ComfyUI loras folder, fetching
    missing ones from their HuggingFace link."""
    directory = lora_dir or LORA_DIR
    paths: list[Path] = []
    for lora in loras:
        dest = directory / lora["file"]
        if not dest.exists():
            if not lora.get("hf_url"):
                raise JobError(f"LoRA {lora['file']} is not on the pod and has no hf_url to fetch it from")
            directory.mkdir(parents=True, exist_ok=True)
            http = session or requests.Session()
            headers = {"Authorization": f"Bearer {HF_TOKEN}"} if HF_TOKEN else {}
            url = hf_resolve_url(lora["hf_url"])
            repo = hf_repo_of(lora["hf_url"])
            if repo:
                # A repo page rather than a file: pick the weight file and save it under the studio's name.
                picked, url = hf_pick_file(repo, lora["file"], http, headers)
                print(f"[lora] {repo}: using {picked} as {lora['file']}", file=sys.stderr)
            with http.get(url, stream=True, timeout=600, headers=headers) as res:
                if res.status_code >= 400:
                    raise JobError(f"could not download LoRA {lora['file']} ({res.status_code})")
                tmp = dest.with_suffix(dest.suffix + ".part")
                with open(tmp, "wb") as fh:
                    for chunk in res.iter_content(chunk_size=1 << 20):
                        fh.write(chunk)
                tmp.replace(dest)
        paths.append(dest)
    return paths


# ---------- Open-H3-Regenerate-2K ----------


def validate_regen_input(raw: dict[str, Any]) -> dict[str, Any]:
    """{workflow: REGEN, video: url, prompt, resolution: 768p|1080p|2k|4k, start_sigma?, steps?, seed?, sparse?, output: {key}, studio_take_id?}"""
    video = raw.get("video")
    if not isinstance(video, str) or not video.startswith(("http://", "https://")):
        raise JobError("regen needs the draft video url in `video`")
    prompt = raw.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError("prompt must be a non-empty string (the take's own compiled prompt)")
    resolution = str(raw.get("resolution", "2k")).lower()
    if resolution not in REGEN_RESOLUTIONS:
        raise JobError(f"resolution must be one of {', '.join(REGEN_RESOLUTIONS)}")
    start_sigma = raw.get("start_sigma", 0.0)
    if not isinstance(start_sigma, (int, float)) or not 0 <= float(start_sigma) <= 1:
        raise JobError("start_sigma must be between 0 (release grid) and 1")
    steps = raw.get("steps", 3)
    if not isinstance(steps, int) or not 1 <= steps <= 8:
        raise JobError("steps must be an integer between 1 and 8")
    seconds = raw.get("seconds", 5)
    if not isinstance(seconds, (int, float)) or not 1 <= seconds <= 15:
        raise JobError("seconds must be between 1 and 15")
    seed = raw.get("seed")
    if seed is None:
        seed = 1766580932
    elif not isinstance(seed, int):
        raise JobError("seed must be an integer")
    output = raw.get("output") or {}
    key = output.get("key") if isinstance(output, dict) else None
    if not isinstance(key, str) or not key.endswith(".mp4"):
        raise JobError("output.key must be an R2 key ending in .mp4")
    return {
        "workflow": REGEN_WORKFLOW, "video": video, "prompt": prompt, "resolution": resolution, "start_sigma": float(start_sigma), "steps": steps,
        "seconds": float(seconds), "seed": seed, "sparse": bool(raw.get("sparse", False)), "input_size": str(raw.get("input_size", "768p")),
        "output_key": key, "studio_take_id": raw.get("studio_take_id"),
    }


def regen_status(models_dir: Path | None = None) -> dict[str, Any]:
    """Whether the Open-H3-Regenerate-2K weights and node pack are on the pod."""
    base = models_dir or Path(os.environ.get("MODELS_DIR", str(LORA_DIR.parent)))
    missing = [f"{sub}/{name}" for sub, name in REGEN_FILES if not ((base / sub / name).is_file() and (base / sub / name).stat().st_size > 1_000_000)]
    nodes = Path(REGEN_NODE_DIR).is_dir()
    return {"ready": not missing and nodes, "missing": missing, "nodes": nodes, "dir": str(base)}


def fill_regen_graph(graph: dict[str, Any], mapping: dict[str, Any], params: dict[str, Any], node_classes: set[str] | None = None) -> dict[str, Any]:
    graph = json.loads(json.dumps(graph))

    def put(target: Any, value: Any) -> None:
        node_id, name = target
        graph[str(node_id)]["inputs"][name] = value

    put(mapping["prompt"], params["prompt"])
    put(mapping["video"], params["files"]["video"])
    put(mapping["resolution"], REGEN_RESOLUTIONS[params["resolution"]])
    put(mapping["steps"], params["steps"])
    put(mapping["start_sigma"], params["start_sigma"])
    put(mapping["seed"], params["seed"])
    put(mapping["max_frames"], 0)  # all frames of the draft (the refine takes 5–15 s in one pass)
    put(mapping["input_size"], "576p (1024x576)" if params.get("input_size") == "576p" else "768p (1344x768)")
    sparse = mapping.get("sparse_attention")
    if params.get("sparse") and sparse and node_classes and sparse["class"] in node_classes:
        # Insert the sparse-attention patch between the LoRA'd model and the guider;
        # its input names come from the pod's own object_info, so a ComfyUI that
        # names them differently still gets a valid node.
        info = node_classes_info.get(sparse["class"]) if isinstance(node_classes_info, dict) else None
        names = [k for k in (info or {}).get("required", {}) if k != "model"] if info else []
        inputs: dict[str, Any] = {"model": [str(sparse["from"]), 0]}
        for name, value in zip(names, sparse["widgets"]):
            inputs[name] = value
        if len(names) >= len(sparse["widgets"]) - 1:
            graph["4"] = {"class_type": sparse["class"], "inputs": inputs, "_meta": {"title": "Model Sparse Attention (sol-attn)"}}
            graph[str(sparse["to"][0])]["inputs"][sparse["to"][1]] = ["4", 0]
    return graph


node_classes_info: dict[str, Any] = {}


def run_regen_job(params: dict[str, Any], comfy: ComfyClient, uploader: Any, workdir: Path, mapping: dict[str, Any] | None = None, should_cancel: Callable[[], bool] | None = None, report: Callable[[dict[str, Any]], Any] | None = None) -> dict[str, Any]:
    started = time.monotonic()
    cancelled = should_cancel or (lambda: False)
    report = report or (lambda p: None)
    status = regen_status()
    if not status["ready"]:
        raise JobError(f"Open-H3-Regenerate-2K is not ready on this pod: missing {status['missing'] or 'the node pack'} — the pod downloads it at boot when REGEN_2K=1")
    mapping = mapping or load_mapping()
    entry = mapping.get(REGEN_WORKFLOW)
    if not entry:
        raise JobError("mapping.json has no REGEN entry")
    graph = load_workflow(entry.get("template", REGEN_WORKFLOW))
    report({"stage": "inputs"})
    inputs = workdir / "in"
    inputs.mkdir(exist_ok=True)
    local = download(params["video"], inputs / f"draft.{ext_of(params['video'], 'mp4')}", comfy.http)
    name = comfy.upload_image(local)  # ComfyUI's upload endpoint takes any file into input/
    if cancelled():
        raise JobError("cancelled")
    classes: set[str] = set()
    if params.get("sparse"):
        try:
            res = comfy.http.get(f"{comfy.base}/object_info/{entry['sparse_attention']['class']}", timeout=30)
            if res.ok:
                node_classes_info.update(res.json())
                classes = set(node_classes_info)
        except requests.RequestException:
            pass
    filled = fill_regen_graph(graph, entry, {**params, "files": {"video": name}}, classes)
    client_id = uuid.uuid4().hex
    watcher = ProgressWatcher(comfy.base, client_id, {nid: n.get("class_type", "") for nid, n in filled.items()}, report)
    watcher.start()
    try:
        prompt_id = comfy.queue(filled, client_id)
        watcher.prompt_id = prompt_id
        report({"stage": "queued"})
        history = comfy.wait(prompt_id, timeout_s=float(entry.get("timeout_s", 2400)), should_cancel=cancelled)
    finally:
        watcher.stop()
    report({"stage": "uploading"})
    out_dir = workdir / "out"
    out_dir.mkdir(exist_ok=True)
    video = comfy.fetch_output(history, entry.get("output_node", ""), out_dir)
    last, thumbs = extract_frames(video, out_dir)
    keys = derive_keys(params["output_key"])
    url = uploader.upload(video, keys["video"], "video/mp4")
    thumb_urls = [uploader.upload(t, k, "image/jpeg") for t, k in zip(thumbs, keys["thumbs"])]
    last_url = uploader.upload(last, keys["last_frame"], "image/png")
    return {
        "url": url, "thumb_urls": thumb_urls, "last_frame_url": last_url, "resolution": params["resolution"],
        "execution_ms": int((time.monotonic() - started) * 1000), "studio_take_id": params.get("studio_take_id"), "duration_s": probe_duration(video),
    }


# ---------- progress ----------

STAGE_BY_CLASS = {
    "UNETLoader": "loading", "CLIPLoader": "loading", "VAELoader": "loading", "LoraLoaderModelOnly": "loading",
    "SamplerCustomAdvanced": "sampling", "VAEDecode": "decoding", "VAEDecodeAudio": "decoding", "SaveVideo": "finishing", "CreateVideo": "finishing",
    "OpenH3RegenLora": "loading", "VAEEncode": "encoding", "OpenH3RegenUpscale": "upscaling", "OpenH3RegenFastVAEDecode": "decoding", "OpenH3RegenFinish": "finishing",
}


class ProgressWatcher:
    """Follows one prompt on ComfyUI's websocket (the messages go to the
    client id that queued it) and turns them into a small progress dict:
    {stage, step, total, percent, secondsPerStep, etaSeconds, node}. Works
    without a socket too: feed handle(message) in tests. Missing
    websocket-client means no live progress, not a failed job."""

    def __init__(self, base_url: str, client_id: str, node_classes: dict[str, str], report: Callable[[dict[str, Any]], Any] | None = None) -> None:
        self.ws_url = base_url.replace("https://", "wss://").replace("http://", "ws://").rstrip("/") + f"/ws?clientId={client_id}"
        self.node_classes = node_classes
        self.report = report or (lambda p: None)
        self.prompt_id: str | None = None
        self.state: dict[str, Any] = {"stage": "queued"}
        self._steps: list[tuple[float, int]] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        try:
            import websocket  # type: ignore  # websocket-client
        except ImportError:
            print("[progress] websocket-client is not installed; no live progress", file=sys.stderr)
            return

        def run() -> None:
            while not self._stop.is_set():
                try:
                    ws = websocket.create_connection(self.ws_url, timeout=5)
                    while not self._stop.is_set():
                        try:
                            raw = ws.recv()
                        except websocket.WebSocketTimeoutException:
                            continue
                        if isinstance(raw, (bytes, bytearray)):
                            continue  # binary previews
                        try:
                            self.handle(json.loads(raw))
                        except (ValueError, TypeError):
                            pass
                    ws.close()
                except Exception:  # noqa: BLE001 — reconnect until stopped
                    time.sleep(1)

        self._thread = threading.Thread(target=run, name="progress", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _emit(self, **fields: Any) -> None:
        self.state = {**self.state, **fields}
        st = self.state
        print(f"[progress] {st.get('stage')}" + (f" {st.get('step')}/{st.get('total')} eta={st.get('etaSeconds')}s" if st.get("stage") == "sampling" else ""), file=sys.stderr, flush=True)
        self.report(dict(self.state))

    def _progress(self, value: int, total: int | None) -> None:
        now = time.monotonic()
        if self._steps and self._steps[-1][1] == value:
            return
        self._steps.append((now, value))
        self._steps = self._steps[-8:]
        per_step = None
        if len(self._steps) >= 2 and self._steps[-1][1] > self._steps[0][1]:
            per_step = (self._steps[-1][0] - self._steps[0][0]) / (self._steps[-1][1] - self._steps[0][1])
        eta = round(per_step * (total - value)) if per_step and total else None
        self._emit(stage="sampling", step=value, total=total, percent=round(100 * value / total) if total else None,
                   secondsPerStep=round(per_step, 1) if per_step else None, etaSeconds=eta)

    def handle(self, msg: dict[str, Any]) -> None:
        kind, data = msg.get("type"), msg.get("data") or {}
        if self.prompt_id and data.get("prompt_id") and data["prompt_id"] != self.prompt_id:
            return
        if kind == "executing":
            node = data.get("node")
            if node is None:
                return
            stage = STAGE_BY_CLASS.get(self.node_classes.get(str(node), ""), "preparing")
            if stage != self.state.get("stage"):
                self._emit(stage=stage, node=str(node))
        elif kind == "progress":
            self._progress(int(data.get("value", 0)), int(data.get("max", 0)) or None)
        elif kind == "progress_state":
            # Newer ComfyUI: {"nodes": {id: {"state": "running", "value": v, "max": m, ...}}}
            nodes = data.get("nodes") or {}
            for nid, st in nodes.items():
                if not isinstance(st, dict) or st.get("state") != "running":
                    continue
                if STAGE_BY_CLASS.get(self.node_classes.get(str(nid), ""), "") == "sampling" and st.get("max"):
                    self._progress(int(st.get("value", 0)), int(st.get("max", 0)) or None)
        elif kind in ("execution_success", "execution_error", "execution_interrupted"):
            self._emit(stage="finishing" if kind == "execution_success" else kind.replace("execution_", ""))


# ---------- ComfyUI ----------


class ComfyClient:
    def __init__(self, base_url: str = COMFY_URL, session: requests.Session | None = None):
        self.base = base_url.rstrip("/")
        self.http = session or requests.Session()

    def health(self) -> dict[str, Any]:
        try:
            res = self.http.get(f"{self.base}/system_stats", timeout=5)
            return {"reachable": res.ok, "status": res.status_code}
        except requests.RequestException as exc:
            return {"reachable": False, "error": str(exc)}

    def upload_image(self, path: Path) -> str:
        with open(path, "rb") as fh:
            res = self.http.post(f"{self.base}/upload/image", files={"image": (path.name, fh)}, data={"overwrite": "true"}, timeout=120)
        res.raise_for_status()
        return res.json().get("name", path.name)

    def queue(self, graph: dict[str, Any], client_id: str | None = None) -> str:
        res = self.http.post(f"{self.base}/prompt", json={"prompt": graph, "client_id": client_id or uuid.uuid4().hex}, timeout=60)
        if not res.ok:
            raise JobError(f"ComfyUI rejected the graph ({res.status_code}): {res.text[:500]}")
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise JobError("ComfyUI returned no prompt_id")
        return prompt_id

    def interrupt(self) -> None:
        """Stop whatever ComfyUI is executing right now."""
        self.http.post(f"{self.base}/interrupt", timeout=10)

    def dequeue(self, prompt_id: str) -> None:
        """Drop a prompt that is still waiting in ComfyUI's queue."""
        self.http.post(f"{self.base}/queue", json={"delete": [prompt_id]}, timeout=10)

    def wait(self, prompt_id: str, timeout_s: float = 1800, poll_s: float = 2.0, should_cancel: Callable[[], bool] | None = None) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if should_cancel and should_cancel():
                for stop in (lambda: self.dequeue(prompt_id), self.interrupt):
                    try:
                        stop()
                    except requests.RequestException:
                        pass
                raise JobError("cancelled")
            res = self.http.get(f"{self.base}/history/{prompt_id}", timeout=30)
            res.raise_for_status()
            entry = res.json().get(prompt_id)
            if entry:
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise JobError(f"ComfyUI reported an error: {json.dumps(status.get('messages', []))[:800]}")
                if entry.get("outputs"):
                    return entry
            time.sleep(poll_s)
        raise JobError("timed out waiting for ComfyUI")

    def fetch_output(self, history: dict[str, Any], output_node: str, dest_dir: Path) -> Path:
        outputs = history.get("outputs", {})
        node_out = outputs.get(str(output_node)) or next(iter(outputs.values()), {})
        # SaveVideo reports its mp4 under "images" in this ComfyUI build; older nodes use videos/gifs/files.
        files = node_out.get("videos") or node_out.get("gifs") or node_out.get("files") or node_out.get("images") or []
        if not files:
            raise JobError(f"ComfyUI produced no video on node {output_node}")
        meta = files[0]
        params = {"filename": meta["filename"], "subfolder": meta.get("subfolder", ""), "type": meta.get("type", "output")}
        res = self.http.get(f"{self.base}/view", params=params, stream=True, timeout=600)
        res.raise_for_status()
        dest = dest_dir / "result.mp4"
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(1 << 20):
                fh.write(chunk)
        return dest


# ---------- files ----------


def download(url: str, dest: Path, session: requests.Session | None = None) -> Path:
    http = session or requests
    with http.get(url, stream=True, timeout=300) as res:
        res.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(1 << 20):
                fh.write(chunk)
    return dest


IMAGE_MAGIC = {
    b"\x89PNG": "png", b"\xff\xd8\xff": "jpg", b"GIF8": "gif", b"BM": "bmp",
}


def sniff_image(path: Path) -> str | None:
    """'png' / 'jpg' / 'webp' / 'gif' / 'bmp' / 'heic' / 'avif' / 'html' / 'json' / None."""
    head = path.read_bytes()[:64] if path.exists() else b""
    for magic, kind in IMAGE_MAGIC.items():
        if head.startswith(magic):
            return kind
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        return "avif" if brand.startswith(b"avi") else "heic"
    lowered = head.lstrip().lower()
    if lowered.startswith(b"<!doctype") or lowered.startswith(b"<html"):
        return "html"
    if lowered.startswith(b"{") or lowered.startswith(b"["):
        return "json"
    return None


def download_image(url: str, dest: Path, session: requests.Session | None = None) -> Path:
    """download() plus a check that what came back is an image ComfyUI can
    open; HEIC/AVIF are converted with ffmpeg, HTML (a login page in front
    of the media URL) and other junk raise a JobError that names the cause."""
    download(url, dest, session)
    kind = sniff_image(dest)
    size = dest.stat().st_size
    if kind in ("png", "jpg", "webp", "gif", "bmp"):
        return dest
    if kind == "html":
        raise JobError(f"image URL answered with an HTML page, not an image ({url}): the pod is not logged in — put /media/* (or wherever the assets live) on the Cloudflare Access bypass list")
    if kind == "json":
        raise JobError(f"image URL answered with JSON, not an image ({url}): {dest.read_bytes()[:200]!r}")
    if kind in ("heic", "avif") or kind is None:
        converted = dest.with_suffix(".png")
        if converted == dest:
            converted = dest.with_name(dest.stem + "_conv.png")
        proc = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(dest), "-frames:v", "1", str(converted)], capture_output=True, text=True)
        if proc.returncode == 0 and converted.exists() and sniff_image(converted) == "png":
            return converted
        raise JobError(f"image at {url} is not a format ComfyUI can read ({kind or 'unknown'}, {size} bytes) and ffmpeg could not convert it: upload PNG, JPEG or WebP ({proc.stderr.strip()[:200]})")
    return dest


def ext_of(url: str, fallback: str) -> str:
    tail = url.split("?", 1)[0].rsplit("/", 1)[-1]
    return tail.rsplit(".", 1)[-1].lower() if "." in tail else fallback


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out) if out else 0.0


def extract_frames(video: Path, out_dir: Path) -> tuple[Path, list[Path]]:
    """Last frame as PNG plus THUMB_COUNT evenly spaced JPEG thumbnails."""
    duration = probe_duration(video)
    last = out_dir / "last.png"
    # Decode the tail and let -update overwrite one file: the final write is the last frame.
    subprocess.run([FFMPEG, "-v", "error", "-y", "-sseof", "-0.3", "-i", str(video), "-update", "1", str(last)], check=True)
    thumbs: list[Path] = []
    for i in range(THUMB_COUNT):
        t = max(0.0, (i + 0.5) / THUMB_COUNT * duration - 0.01)
        thumb = out_dir / f"thumb{i}.jpg"
        subprocess.run(
            [FFMPEG, "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(video), "-frames:v", "1", "-vf", f"scale={THUMB_WIDTH}:-2", "-q:v", "4", str(thumb)],
            check=True,
        )
        thumbs.append(thumb)
    return last, thumbs


# ---------- R2 ----------


class R2Uploader:
    def __init__(self, env: dict[str, str] | None = None):
        env = env or os.environ  # type: ignore[assignment]
        import boto3  # imported here so tests can run without credentials

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


def run_job(params: dict[str, Any], comfy: ComfyClient, uploader: Any, workdir: Path, mapping: dict[str, Any] | None = None, should_cancel: Callable[[], bool] | None = None, report: Callable[[dict[str, Any]], Any] | None = None) -> dict[str, Any]:
    started = time.monotonic()
    cancelled = should_cancel or (lambda: False)
    report = report or (lambda p: None)
    report({"stage": "inputs"})
    mapping = mapping or load_mapping()
    entry = mapping.get(params["workflow"])
    if not entry:
        raise JobError(f"mapping.json has no entry for {params['workflow']}")
    graph = load_workflow(entry.get("template", params["workflow"]))

    inputs = workdir / "in"
    inputs.mkdir(exist_ok=True)
    files: dict[str, Any] = {"reference": []}
    for i, img in enumerate(params["images"]):
        local = download_image(img["url"], inputs / f"{img['role']}{i}.{ext_of(img['url'], 'png')}", comfy.http)
        name = comfy.upload_image(local)
        if img["role"] == "reference":
            files["reference"].append(name)
        else:
            files[img["role"]] = name
    if params.get("video"):
        local = download(params["video"], inputs / f"source.{ext_of(params['video'], 'mp4')}", comfy.http)
        files["video"] = comfy.upload_image(local)

    if params.get("loras"):
        ensure_loras(params["loras"], session=comfy.http)
    if cancelled():
        raise JobError("cancelled")
    filled = fill_graph(graph, entry, {**params, "files": files})
    client_id = uuid.uuid4().hex
    watcher = ProgressWatcher(comfy.base, client_id, {nid: n.get("class_type", "") for nid, n in filled.items()}, report)
    watcher.start()
    try:
        prompt_id = comfy.queue(filled, client_id)
        watcher.prompt_id = prompt_id
        report({"stage": "queued"})
        history = comfy.wait(prompt_id, timeout_s=float(entry.get("timeout_s", 1800)), should_cancel=cancelled)
    finally:
        watcher.stop()
    report({"stage": "uploading"})
    out_dir = workdir / "out"
    out_dir.mkdir(exist_ok=True)
    video = comfy.fetch_output(history, entry.get("output_node", ""), out_dir)
    last, thumbs = extract_frames(video, out_dir)

    keys = derive_keys(params["output_key"])
    url = uploader.upload(video, keys["video"], "video/mp4")
    last_url = uploader.upload(last, keys["last_frame"], "image/png")
    thumb_urls = [uploader.upload(t, k, "image/jpeg") for t, k in zip(thumbs, keys["thumbs"])]
    return {
        "url": url,
        "last_frame_url": last_url,
        "thumb_urls": thumb_urls,
        "execution_ms": int((time.monotonic() - started) * 1000),
        "seed": params["seed"],
        "studio_take_id": params.get("studio_take_id"),
        "duration_s": probe_duration(video),
    }


def models_status(models_dir: Path | None = None) -> dict[str, Any]:
    """Which of the files in models.txt are present under the models dir
    (diffusion_models and unet are the same folder on the runpod image)."""
    base = models_dir or Path(os.environ.get("MODELS_DIR", str(LORA_DIR.parent)))
    listing = Path(__file__).resolve().parent / "models.txt"
    missing: list[str] = []
    expected = 0
    if listing.exists():
        for line in listing.read_text().splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            subdir, _, url = line.partition("\t")
            name = url.strip().rsplit("/", 1)[-1]
            expected += 1
            dirs = [subdir] + (["unet"] if subdir == "diffusion_models" else ["diffusion_models"] if subdir == "unet" else [])
            if not any((base / d / name).is_file() and (base / d / name).stat().st_size > 1_000_000 for d in dirs):
                missing.append(f"{subdir}/{name}")
    return {"ready": expected > 0 and not missing, "dir": str(base), "expected": expected, "missing": missing}


def health(comfy: ComfyClient) -> dict[str, Any]:
    loaded = sorted(p.stem for p in WORKFLOW_DIR.glob("*.json") if p.stem != "mapping")
    return {"ok": True, "comfy": comfy.health(), "models": models_status(), "regen": regen_status(), "workflows": loaded, "workflow_dir": str(WORKFLOW_DIR)}


def handler(event: dict[str, Any], should_cancel: Callable[[], bool] | None = None, report: Callable[[dict[str, Any]], Any] | None = None) -> dict[str, Any]:
    """RunPod entry point. Returning {"error": ...} marks the job FAILED."""
    raw = event.get("input") or {}
    comfy = ComfyClient()
    if raw.get("action") == "health":
        return health(comfy)
    try:
        params = validate_input(raw)
        with tempfile.TemporaryDirectory(prefix="h3-") as tmp:
            if params["workflow"] == REGEN_WORKFLOW:
                return run_regen_job(params, comfy, R2Uploader(), Path(tmp), should_cancel=should_cancel, report=report)
            return run_job(params, comfy, R2Uploader(), Path(tmp), should_cancel=should_cancel, report=report)
    except JobError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surface everything to the Studio
        return {"error": f"{type(exc).__name__}: {exc}"}


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[0] == "--local":
        print(json.dumps(handler({"input": json.loads(argv[1])}), indent=2))
        return 0
    import runpod  # only needed on RunPod itself

    runpod.serverless.start({"handler": handler})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
