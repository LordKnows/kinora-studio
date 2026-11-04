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
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

import requests

WORKFLOWS = ("T2VA", "I2VA", "FL2VA", "R2VA")
ROLES = ("first_frame", "last_frame", "reference")
HERE = Path(__file__).resolve().parent
WORKFLOW_DIR = Path(os.environ.get("WORKFLOW_DIR", HERE / "workflows"))
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
THUMB_COUNT = 4
THUMB_WIDTH = 320


class JobError(Exception):
    """Anything the caller can fix: bad input, missing workflow, no output."""


# ---------- input ----------


def validate_input(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise JobError("input must be an object")
    workflow = raw.get("workflow")
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
    return {
        "workflow": workflow,
        "prompt": prompt,
        "negative": str(raw.get("negative") or ""),
        "seconds": float(seconds),
        "width": width,
        "height": height,
        "steps": steps,
        "seed": seed,
        "enhance": bool(raw.get("enhance", False)),
        "images": images,
        "video": video,
        "output_key": key,
        "studio_take_id": raw.get("studio_take_id"),
    }


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
    put(mapping.get("seconds"), params["seconds"], True, "seconds")
    put(mapping.get("width"), params["width"], False, "width")
    put(mapping.get("height"), params["height"], False, "height")
    put(mapping.get("steps"), params["steps"], False, "steps")
    put(mapping.get("seed"), params["seed"], False, "seed")
    put(mapping.get("enhance"), params["enhance"], False, "enhance")

    files = params.get("files", {})
    if "first_frame" in files:
        put(mapping.get("first_frame"), files["first_frame"], True, "first_frame")
    if "last_frame" in files:
        put(mapping.get("last_frame"), files["last_frame"], True, "last_frame")
    refs = files.get("reference", [])
    targets = mapping.get("reference_images", [])
    if len(refs) > len(targets):
        raise JobError(f"workflow accepts {len(targets)} reference images, got {len(refs)}")
    for target, name in zip(targets, refs):
        put(target, name, True, "reference_images")
    if files.get("video"):
        put(mapping.get("video"), files["video"], True, "video")
    return graph


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

    def queue(self, graph: dict[str, Any]) -> str:
        res = self.http.post(f"{self.base}/prompt", json={"prompt": graph, "client_id": uuid.uuid4().hex}, timeout=60)
        if not res.ok:
            raise JobError(f"ComfyUI rejected the graph ({res.status_code}): {res.text[:500]}")
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise JobError("ComfyUI returned no prompt_id")
        return prompt_id

    def wait(self, prompt_id: str, timeout_s: float = 1800, poll_s: float = 2.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
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
        files = node_out.get("videos") or node_out.get("gifs") or node_out.get("files") or []
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


def run_job(params: dict[str, Any], comfy: ComfyClient, uploader: Any, workdir: Path, mapping: dict[str, Any] | None = None) -> dict[str, Any]:
    started = time.monotonic()
    mapping = mapping or load_mapping()
    entry = mapping.get(params["workflow"])
    if not entry:
        raise JobError(f"mapping.json has no entry for {params['workflow']}")
    graph = load_workflow(entry.get("template", params["workflow"]))

    inputs = workdir / "in"
    inputs.mkdir(exist_ok=True)
    files: dict[str, Any] = {"reference": []}
    for i, img in enumerate(params["images"]):
        local = download(img["url"], inputs / f"{img['role']}{i}.{ext_of(img['url'], 'png')}", comfy.http)
        name = comfy.upload_image(local)
        if img["role"] == "reference":
            files["reference"].append(name)
        else:
            files[img["role"]] = name
    if params.get("video"):
        local = download(params["video"], inputs / f"source.{ext_of(params['video'], 'mp4')}", comfy.http)
        files["video"] = comfy.upload_image(local)

    filled = fill_graph(graph, entry, {**params, "files": files})
    prompt_id = comfy.queue(filled)
    history = comfy.wait(prompt_id, timeout_s=float(entry.get("timeout_s", 1800)))
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


def health(comfy: ComfyClient) -> dict[str, Any]:
    loaded = sorted(p.stem for p in WORKFLOW_DIR.glob("*.json") if p.stem != "mapping")
    return {"ok": True, "comfy": comfy.health(), "workflows": loaded, "workflow_dir": str(WORKFLOW_DIR)}


def handler(event: dict[str, Any]) -> dict[str, Any]:
    """RunPod entry point. Returning {"error": ...} marks the job FAILED."""
    raw = event.get("input") or {}
    comfy = ComfyClient()
    if raw.get("action") == "health":
        return health(comfy)
    try:
        params = validate_input(raw)
        with tempfile.TemporaryDirectory(prefix="h3-") as tmp:
            return run_job(params, comfy, R2Uploader(), Path(tmp))
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
