"""Drawing one picture for the Studio: the work a painter does for a job.

The painter (painter.py) runs this wherever it lives — a small CPU box, a
VPS, the user's computer, or the GPU pod as a fallback. Three ops:

    paint    an image model draws (refs → new image) or edits (`base`); with a
             `region`, only that box of the edit is pasted back onto `base`,
             so every other pixel stays the original's
    crop     a box of `base` scaled back to the canvas (a push-in's end frame)
    extract  one exact frame of a video (the frame a Remake keyframe repaints)

Two paint backends:

    codex    the user's ChatGPT plan through the Codex CLI's image tool. One
             `codex exec` per picture in its own CODEX_HOME (the login copied
             in, a refreshed login copied back), read-only, no MCP. The
             pictures go in as attachments (`-i`, in order), and the result is
             the PNG it leaves under generated_images/.
    api      an OpenAI-compatible images API (OPENAI_API_KEY, OPENAI_BASE_URL,
             IMAGE_MODEL), paid per call, with an exact size.

What makes a picture fail, and what this file does about it:

  * Codex's image tool takes no size: its backend runs with size "auto" and
    shapes the canvas from the prompt. A ratio it knows ("16:9", "3:4") gets
    close; "1344:768" does not. So the prompt names the nearest standard
    ratio, a picture that came back badly off is redrawn once, and whatever
    is cropped to fit is reported (a crop can take heads and feet off).
  * Cheap pixel checks on every result (`checks`): blank or nearly flat,
    borders / letterbox bars, a cropped share, a sheet whose background is
    not plain, an edit that changed far more than it was asked to.
  * A self-review (`check.review`): a fresh `codex exec` looks at the result
    beside the references and the brief and answers a rubric as JSON
    (anatomy, count, identity, mirrored features, text, framing, style,
    background, edit scope). A blocker is redrawn once with the findings
    added (`check.redraws`), and the verdict travels with the picture so the
    director's reviewer starts from it. It uses the plan's Codex usage, not
    image quota; the redraw is a picture and is counted (`drawn`).

Input:
    {op, backend?, prompt?, refs?: [url], base?: url, region?: {x,y,w,h},
     crop?: {x,y,w,h}, video?: url, frame?: int, size: "WxH",
     quality?: low|medium|high, check?: {review?: bool, redraws?: int, kind?: str},
     output: {key: "....png"}, studio_job_id?}
    (boxes are fractions of the picture: 0..1)
Output:
    {url, preview_url, diff_url?, width, height, backend?, attempts?, drawn?,
     checks?: [{id, level, message}], review?: {verdict, findings, summary},
     seconds}
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

import requests

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
MAX_CODEX_PICTURES = 5
# accept a picture this close to the asked aspect (relative); redraw once when further off than REDRAW
ASPECT_TOLERANCE = 0.04
ASPECT_REDRAW = 0.10
PREVIEW_WIDTH = 1024
CODEX_TIMEOUT_S = int(os.environ.get("CODEX_PAINT_TIMEOUT_S", "900"))
REVIEW_TIMEOUT_S = int(os.environ.get("CODEX_REVIEW_TIMEOUT_S", "300"))
QUOTA_WORDS = ("usage limit", "rate limit", "429", "quota", "insufficient_quota", "billing")
MAX_REDRAWS = 2
MAX_COMFY_PICTURES = 10
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
# the pod's ComfyUI queue is shared with the video takes: a picture may wait behind one
COMFY_TIMEOUT_S = int(os.environ.get("COMFY_PAINT_TIMEOUT_S", "2400"))
COMFY_POLL_S = 2.0
HERE = Path(__file__).resolve().parent
# the job server's folder: next to this file on the pod (bundle or image), ../h3-runpod in the repo
POD_DIR = Path(os.environ.get("POD_DIR") or (HERE if (HERE / "workflows").is_dir() else HERE.parent / "h3-runpod"))

CODEX_CONFIG = """approval_policy = "never"
sandbox_mode = "read-only"
suppress_unstable_features_warning = true
[features]
plugins = false
remote_plugin = false
apps = false
"""


class PaintError(Exception):
    """Something the caller can act on (bad input, a refusal, no picture)."""


class QuotaError(PaintError):
    """The plan or the API account is out of image quota: stop painting."""


# ---------- input ----------


def _box(raw: Any, name: str) -> dict[str, float] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise PaintError(f"{name} must be {{x, y, w, h}} as fractions of the picture")
    try:
        x, y, w, h = (float(raw[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        raise PaintError(f"{name} needs numeric x, y, w, h") from None
    if not (0 <= x < 1 and 0 <= y < 1 and 0 < w <= 1 and 0 < h <= 1 and x + w <= 1.0001 and y + h <= 1.0001):
        raise PaintError(f"{name} must lie inside the picture (fractions 0..1)")
    return {"x": x, "y": y, "w": min(w, 1 - x), "h": min(h, 1 - y)}


def parse_size(value: Any) -> tuple[int, int]:
    m = re.fullmatch(r"(\d{2,5})x(\d{2,5})", str(value or ""))
    if not m:
        raise PaintError('size must look like "1344x768"')
    w, h = int(m.group(1)), int(m.group(2))
    if not (64 <= w <= 4096 and 64 <= h <= 4096):
        raise PaintError("size must be between 64 and 4096 pixels per side")
    return w, h


def _check_opts(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"review": False, "redraws": 0, "kind": ""}
    redraws = raw.get("redraws", 0)
    return {
        "review": bool(raw.get("review")),
        "redraws": max(0, min(MAX_REDRAWS, int(redraws))) if isinstance(redraws, (int, float)) else 0,
        "kind": str(raw.get("kind") or "")[:40],
    }


def validate_paint_input(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PaintError("input must be an object")
    op = raw.get("op", "paint")
    if op not in ("paint", "crop", "extract"):
        raise PaintError("op must be paint, crop or extract")
    output = raw.get("output") or {}
    key = output.get("key") if isinstance(output, dict) else None
    if not isinstance(key, str) or not key.endswith(".png"):
        raise PaintError("output.key must be an R2 key ending in .png")
    params: dict[str, Any] = {"op": op, "output_key": key, "studio_job_id": raw.get("studio_job_id")}
    if op in ("paint", "crop") or raw.get("size"):
        params["size"] = parse_size(raw.get("size", "1344x768"))
    if op == "paint":
        prompt = raw.get("prompt")
        if not isinstance(prompt, str) or len(prompt.strip()) < 5:
            raise PaintError("paint needs a prompt")
        backend = raw.get("backend", "codex")
        if not isinstance(backend, str) or not (backend in ("codex", "api") or re.fullmatch(r"comfy:[a-z0-9][a-z0-9._-]{0,60}", backend)):
            raise PaintError("backend must be codex, api or comfy:<model>")
        refs = raw.get("refs") or []
        if not isinstance(refs, list) or not all(isinstance(u, str) and u.startswith(("http://", "https://")) for u in refs):
            raise PaintError("refs must be a list of image urls")
        base = raw.get("base")
        if base is not None and (not isinstance(base, str) or not base.startswith(("http://", "https://"))):
            raise PaintError("base must be an image url")
        if backend == "codex" and len(refs) + (1 if base else 0) > MAX_CODEX_PICTURES:
            raise PaintError(f"Codex's image tool takes at most {MAX_CODEX_PICTURES} pictures (refs + base)")
        if backend.startswith("comfy:") and len(refs) + (1 if base else 0) > MAX_COMFY_PICTURES:
            raise PaintError(f"the pod's image models take at most {MAX_COMFY_PICTURES} pictures (refs + base)")
        region = _box(raw.get("region"), "region")
        if region and not base:
            raise PaintError("region needs a base image to paste back onto")
        quality = raw.get("quality", "low")
        if quality not in ("low", "medium", "high"):
            raise PaintError("quality must be low, medium or high")
        params.update(prompt=prompt.strip(), backend=backend, refs=refs, base=base, region=region, quality=quality, check=_check_opts(raw.get("check")), settings=_settings(raw.get("params")))
    elif op == "crop":
        base = raw.get("base")
        if not isinstance(base, str) or not base.startswith(("http://", "https://")):
            raise PaintError("crop needs a base image url")
        crop = _box(raw.get("crop"), "crop")
        if not crop:
            raise PaintError("crop needs a crop box")
        params.update(base=base, crop=crop)
    else:
        video = raw.get("video")
        frame = raw.get("frame")
        if not isinstance(video, str) or not video.startswith(("http://", "https://")):
            raise PaintError("extract needs a video url")
        if not isinstance(frame, int) or frame < 0:
            raise PaintError("extract needs a frame index (0 = first frame)")
        params.update(video=video, frame=frame)
    return params


# ---------- pictures ----------


def _pil():
    try:
        from PIL import Image, ImageChops, ImageFilter, ImageOps  # noqa: F401
    except ImportError as exc:  # pragma: no cover - the painter installs Pillow
        raise PaintError("Pillow is not installed on this painter (python3 -m pip install pillow)") from exc
    import PIL.Image
    return PIL.Image


def fit(img: Any, w: int, h: int) -> Any:
    """Cover-crop to the w:h aspect around the centre, then resize."""
    Image = _pil()
    img = img.convert("RGB")
    sw, sh = img.size
    s = max(w / sw, h / sh)
    nw, nh = max(w, round(sw * s)), max(h, round(sh * s))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return img.crop((left, top, left + w, top + h))


def cropped_share(src: tuple[int, int], w: int, h: int) -> tuple[float, str]:
    """How much of the drawn picture `fit` cuts away to reach w:h, and from which sides."""
    sw, sh = src
    a, t = sw / sh, w / h
    if abs(a - t) < 1e-6:
        return 0.0, ""
    if a > t:  # too wide: the sides go
        return 1 - t / a, "left and right"
    return 1 - a / t, "top and bottom"


def box_px(box: dict[str, float], w: int, h: int) -> tuple[int, int, int, int]:
    x0, y0 = round(box["x"] * w), round(box["y"] * h)
    x1, y1 = round((box["x"] + box["w"]) * w), round((box["y"] + box["h"]) * h)
    return max(0, x0), max(0, y0), min(w, max(x0 + 1, x1)), min(h, max(y0 + 1, y1))


def paste_back(base: Any, edited: Any, region: dict[str, float], feather_frac: float = 0.015) -> Any:
    """`edited` (any size) fitted to `base`, and only `region` of it pasted
    back with a soft edge. Outside the region every pixel is the base's."""
    Image = _pil()
    from PIL import ImageChops, ImageDraw, ImageFilter

    base = base.convert("RGB")
    w, h = base.size
    edited = fit(edited, w, h)
    x0, y0, x1, y1 = box_px(region, w, h)
    feather = max(1, round(min(w, h) * feather_frac))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rectangle((x0 + feather, y0 + feather, x1 - feather, y1 - feather), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather))
    # the blur must not reach past the box: outside it the base is exact
    hard = Image.new("L", (w, h), 0)
    ImageDraw.Draw(hard).rectangle((x0, y0, x1 - 1, y1 - 1), fill=255)
    mask = ImageChops.multiply(mask, hard)
    return Image.composite(edited, base, mask)


def diff_image(a: Any, b: Any) -> Any:
    """Where two pictures differ, brightened: black means identical."""
    from PIL import ImageChops, ImageOps

    a, b = a.convert("RGB"), fit(b, *a.convert("RGB").size)
    d = ImageChops.difference(a, b).convert("L")
    return ImageOps.autocontrast(d, cutoff=0.5).convert("RGB")


def changed_share(a: Any, b: Any, threshold: int = 40) -> float:
    """Share of pixels that differ noticeably between two same-size pictures."""
    from PIL import ImageChops

    small = (256, max(1, round(256 * a.height / a.width)))
    d = ImageChops.difference(a.convert("RGB").resize(small), b.convert("RGB").resize(small)).convert("L")
    hist = d.histogram()
    return sum(hist[threshold:]) / max(1, sum(hist))


def preview(img: Any) -> Any:
    Image = _pil()
    w, h = img.size
    if w <= PREVIEW_WIDTH:
        return img.convert("RGB")
    return img.convert("RGB").resize((PREVIEW_WIDTH, round(h * PREVIEW_WIDTH / w)), Image.LANCZOS)


# the ratios image models are trained on; a prompt that names one gets it
NAMED_RATIOS = [(1, 1), (5, 4), (4, 3), (3, 2), (16, 9), (2, 1), (21, 9), (4, 5), (3, 4), (2, 3), (9, 16)]


def nearest_ratio(w: int, h: int) -> tuple[int, int]:
    return min(NAMED_RATIOS, key=lambda r: abs((r[0] / r[1]) / (w / h) - 1))


def shape_hint(w: int, h: int) -> str:
    """Codex's image tool has no size argument and picks the canvas from the
    prompt: name a ratio the model knows, and the orientation in words."""
    rw, rh = nearest_ratio(w, h)
    orient = "portrait (taller than wide)" if h > w else "landscape (wider than tall)" if w > h else "square"
    use = {(16, 9): ", a widescreen film frame", (21, 9): ", a cinemascope film frame", (9, 16): ", a vertical phone frame", (3, 4): ", a portrait page", (2, 3): ", a tall portrait"}.get((rw, rh), "")
    return f"\n\nOutput format: one {orient} image, {rw}:{rh} aspect ratio{use}. Fill the whole canvas edge to edge: no borders, no frame, no letterbox bars."


def request_size(w: int, h: int, px: int = 1664 * 960) -> tuple[int, int]:
    """W:H at the image models' ~1.6 MP, multiples of 16."""
    s = (px / (w * h)) ** 0.5
    return round(w * s / 16) * 16, round(h * s / 16) * 16


# ---------- automatic checks (pixels only, no model) ----------


def _stats(img: Any) -> tuple[float, float]:
    from PIL import ImageStat

    st = ImageStat.Stat(img.convert("L"))
    return st.mean[0], st.stddev[0]


def _flat_band(img: Any, side: str) -> bool:
    """A uniform strip along one edge that ends abruptly (a border or a letterbox bar)."""
    from PIL import ImageStat

    g = img.convert("L")
    # turn the picture so that the edge looked at is the top (PIL rotates counter-clockwise)
    g = {"top": g, "bottom": g.rotate(180), "left": g.rotate(270, expand=True), "right": g.rotate(90, expand=True)}[side]
    g = g.resize((256, max(8, round(256 * g.height / g.width))))
    rows = g.height
    first = None
    run = 0
    for y in range(int(rows * 0.25)):
        st = ImageStat.Stat(g.crop((0, y, g.width, y + 1)))
        mean, sd = st.mean[0], st.stddev[0]
        if first is None:
            first = mean
        if sd > 4 or abs(mean - first) > 4:
            break
        run += 1
    if run < max(2, rows * 0.015) or run >= rows * 0.25:
        return False
    after = ImageStat.Stat(g.crop((0, run, g.width, min(rows, run + 3))))
    return abs(after.mean[0] - (first or 0)) > 15 or after.stddev[0] > 15


def auto_checks(img: Any, *, drawn_size: tuple[int, int] | None, target: tuple[int, int], kind: str = "", base: Any = None, region: dict[str, float] | None = None) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    w, h = target
    mean, sd = _stats(img)
    if sd < 6:
        out.append({"id": "blank", "level": "fail", "message": f"the picture is nearly flat (brightness {mean:.0f}, spread {sd:.1f}): nothing was drawn"})
    if drawn_size:
        share, sides = cropped_share(drawn_size, w, h)
        if share > 0.02:
            out.append({"id": "cropped", "level": "warn" if share < 0.2 else "fail",
                        "message": f"drawn {drawn_size[0]}x{drawn_size[1]}; {share:.0%} cut off the {sides} to fit {w}x{h} — check heads, feet and hands at the edges"})
    bars = [s for s in ("top", "bottom", "left", "right") if _flat_band(img, s)] if kind != "element_sheet" else []
    if bars:
        out.append({"id": "border", "level": "warn", "message": f"a flat band along the {', '.join(bars)} edge: a border or letterbox bar drawn into the picture"})
    if kind in ("element_sheet",) and img.width > 64:
        # a sheet is read as identity: its background must be plain
        corners = [img.crop(b) for b in ((0, 0, w // 8, h // 8), (w - w // 8, 0, w, h // 8), (0, h - h // 8, w // 8, h), (w - w // 8, h - h // 8, w, h))]
        sds = [_stats(c)[1] for c in corners]
        if sum(1 for s in sds if s > 18) >= 2:
            out.append({"id": "busy_background", "level": "warn", "message": "the corners are not plain: a reference sheet should stand on an empty backdrop, or R2VA copies the background into every shot"})
    if base is not None and region is None:
        share = changed_share(fit(base, w, h), img)
        if share > 0.45:
            out.append({"id": "edit_scope", "level": "warn", "message": f"{share:.0%} of the picture changed: the edit redrew far more than it was asked to (faces, light and framing may have drifted); try a region edit"})
    return out


# ---------- codex ----------


def codex_bin() -> str:
    explicit = os.environ.get("CODEX_BIN")
    if explicit:
        return explicit
    for root in (os.environ.get("STUDIO_VOLUME_PATH"), os.environ.get("PAINTER_STATE_DIR")):
        if root and (Path(root) / "codex" / "bin" / "codex").is_file():
            return str(Path(root) / "codex" / "bin" / "codex")
    return shutil.which("codex") or "codex"


def codex_home() -> Path:
    """The master login: on the volume / the painter's state dir when there is
    one, so a login survives a restart and a refreshed token is written there."""
    explicit = os.environ.get("CODEX_HOME_MASTER")
    if explicit:
        return Path(explicit)
    for root in (os.environ.get("STUDIO_VOLUME_PATH"), os.environ.get("PAINTER_STATE_DIR")):
        if root:
            return Path(root) / "codex" / "home"
    return Path.home() / ".codex"


_auth_lock = threading.Lock()


def _picture_lines(n_refs: int, has_base: bool) -> str:
    lines = [f"Image {k + 1}: reference picture {k + 1} (as described in the prompt)." for k in range(n_refs)]
    if has_base:
        lines.append(f"Image {n_refs + 1}: the picture to edit.")
    return "\n".join(lines)


def _codex_message(prompt: str, pictures: list[str], w: int, h: int, *, has_base: bool = False) -> str:
    att = ""
    if pictures:
        att = (
            f"\n\nThe {len(pictures)} attached image(s), in this order, are the image tool's input images "
            f"(if the tool takes file paths, they are: {json.dumps(pictures)}):\n"
            + _picture_lines(len(pictures) - (1 if has_base else 0), has_base)
        )
    return (
        "Call your image generation tool exactly once, with the prompt below verbatim (no rewording, nothing added or "
        "dropped) and every attached image as an input image." + att
        + "\n\nDo nothing else: no files, no shell, no commentary. If the tool refuses, reply REFUSED and the tool's "
        "message, and stop.\n\nPROMPT:\n" + prompt + shape_hint(w, h)
    )


def _prepare_home(workdir: Path, tag: str) -> tuple[Path, Path, bytes]:
    master = codex_home()
    auth = master / "auth.json"
    if not auth.is_file():
        raise PaintError("Codex is not logged in on this painter: open the Machine page → Painters → Log in")
    home = workdir / f"codex-{tag}" / "home"
    ws = workdir / f"codex-{tag}" / "ws"
    home.mkdir(parents=True)
    ws.mkdir()
    with _auth_lock:
        shutil.copy(auth, home / "auth.json")
    (home / "config.toml").write_text(CODEX_CONFIG)
    return home, ws, (home / "auth.json").read_bytes()


def _keep_refreshed_login(home: Path, copied: bytes) -> None:
    # a refreshed login comes back: keep it, or the next job uses a revoked token
    refreshed = home / "auth.json"
    if refreshed.is_file() and refreshed.read_bytes() != copied:
        auth = codex_home() / "auth.json"
        with _auth_lock:
            tmp = auth.with_suffix(".json.tmp")
            shutil.copy(refreshed, tmp)
            os.replace(tmp, auth)


def _codex_cmd(ws: Path, pictures: list[Path], effort: str, no_code_mode: bool) -> list[str]:
    cmd = [codex_bin(), "exec", "--skip-git-repo-check", "-C", str(ws), "-c", f'model_reasoning_effort="{effort}"', "--json"]
    if no_code_mode:
        # Codex 0.16x runs tool calls through the separate codex-code-mode-host
        # helper; when it cannot start, ask for the tools directly instead.
        cmd += ["-c", "features.code_mode=false"]
    model = os.environ.get("CODEX_PAINT_MODEL")
    if model:
        cmd += ["-m", model]
    for p in pictures:
        cmd += ["-i", str(p.resolve())]
    return cmd


def _said(stdout: str) -> str:
    out = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if '"agent_message"' not in line or not line.startswith("{"):
            continue
        try:
            out.append(json.loads(line).get("item", {}).get("text", ""))
        except json.JSONDecodeError:
            continue
    return " ".join(out)


def run_codex(prompt: str, pictures: list[Path], w: int, h: int, workdir: Path,
              runner: Callable[..., subprocess.CompletedProcess] = subprocess.run, *, has_base: bool = False,
              tag: str = "draw") -> tuple[Any, int, tuple[int, int]]:
    """One picture from Codex's image tool. Returns (PIL image as drawn, attempts, drawn size).
    A picture far off the asked aspect is redrawn once; one close enough is kept (and fitted later)."""
    Image = _pil()
    why = ""
    no_code_mode = os.environ.get("CODEX_CODE_MODE", "auto") == "off"
    target = w / h
    for attempt in (1, 2):
        home, ws, copied = _prepare_home(workdir, f"{tag}{attempt}")
        message = _codex_message(prompt, [str(p.resolve()) for p in pictures], w, h, has_base=has_base)
        if attempt == 2 and why.startswith("aspect:"):
            message += f" This is a retry: the last picture came back {why[len('aspect:'):]}; the canvas MUST be {nearest_ratio(w, h)[0]}:{nearest_ratio(w, h)[1]}."
        # `-i` takes several files: without `--` the prompt is read as one more picture
        # and Codex falls back to reading the prompt from stdin ("No prompt provided")
        cmd = _codex_cmd(ws, pictures, "low", no_code_mode) + ["--", message]
        try:
            r = runner(cmd, env={**os.environ, "CODEX_HOME": str(home)}, stdin=subprocess.DEVNULL,
                       capture_output=True, text=True, timeout=CODEX_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            why = f"codex timed out after {CODEX_TIMEOUT_S}s"
            continue
        except FileNotFoundError:
            raise PaintError("the Codex CLI is not installed on this painter (install_codex.sh; see the painter log)") from None
        _keep_refreshed_login(home, copied)
        pngs = sorted((home / "generated_images").glob("*/*.png"), key=lambda p: p.stat().st_mtime)
        said = _said(r.stdout)
        if pngs:
            img = Image.open(pngs[-1]).convert("RGB")
            off = abs((img.width / img.height) / target - 1)
            if off <= ASPECT_REDRAW or attempt == 2:
                return img, attempt, img.size
            why = f"aspect:{img.width}x{img.height}"
            continue
        why = (said or (r.stderr or "")[-400:] or f"exit {r.returncode}, no picture").strip()[:400]
        if any(q in why.lower() for q in QUOTA_WORDS):
            raise QuotaError(f"codex: {why}")
        if "code-mode host" in why.lower() or "code_mode_host" in why.lower():
            no_code_mode = True
    if "code-mode host" in why.lower():
        why += f" — codex-code-mode-host must sit next to {codex_bin()} (install_codex.sh installs both; restart the painter)"
    raise PaintError(f"no picture after 2 tries: {why}")


REVIEW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["verdict", "summary", "findings"],
    "properties": {
        "verdict": {"type": "string", "enum": ["pass", "fail"]},
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["code", "severity", "where", "what", "fix"],
                "properties": {
                    "code": {"type": "string", "enum": ["anatomy", "count", "identity", "wardrobe", "feature_side", "text", "framing", "aspect", "style", "background", "extra", "edit_scope", "prompt_mismatch", "other"]},
                    "severity": {"type": "string", "enum": ["blocker", "minor"]},
                    "where": {"type": "string"},
                    "what": {"type": "string"},
                    "fix": {"type": "string"},
                },
            },
        },
    },
}

REVIEW_RUBRIC = """You are a strict picture checker for a film studio. You did not draw this picture. Look at it at full size, beside the reference pictures, and compare it with the brief it was drawn from. Do not redraw or edit anything.

Check, in this order:
1. anatomy: hands (count the fingers), arms, legs, faces, eyes, teeth; nothing melted, fused, doubled or missing.
2. count: exactly the people, animals and objects the brief names — no extra person, no missing one, no duplicate of the same person.
3. identity / wardrobe: every person and thing that has a reference picture matches it — face, hair, build, age, clothes, colours, props.
4. feature_side: a fixed feature the brief puts on one side (a scar on the LEFT cheek, a bag on the RIGHT shoulder) is on that side of the PERSON; a mirrored picture is a blocker.
5. text: any letters, numbers, captions, labels, logos, watermarks, signatures, borders or panel grids that the brief did not ask for.
6. framing: heads, feet or hands cut by the edge when they should be in; the subject where the brief puts it (left third / centre / right third); headroom.
7. style / background: matches the style asked for and, for a reference sheet, one figure only on a plain empty backdrop; for a frame, the setting asked for.
8. edit_scope (edits only): only what the brief asked to change changed; faces, light, framing and everything else identical to the picture being edited.
9. prompt_mismatch: anything else the brief asks for that is not there, or is clearly wrong.

A blocker is anything a viewer would notice or a video model would copy into every frame. Minor is a nit. Verdict fail when there is at least one blocker. For each finding give where (as "top-left quarter", "her right hand", or a box in fractions x,y,w,h), what is wrong, and fix: the shortest instruction that would fix it (for a region edit or a redraw)."""


def review_with_codex(picture: Path, brief: str, refs: list[Path], workdir: Path, *, kind: str = "", base: Path | None = None,
                      runner: Callable[..., subprocess.CompletedProcess] = subprocess.run, tag: str = "review") -> dict[str, Any] | None:
    """A fresh Codex session checks the picture against the brief and the refs; None when it could not answer."""
    try:
        home, ws, copied = _prepare_home(workdir, tag)
    except PaintError:
        return None
    schema = workdir / f"{tag}-schema.json"
    schema.write_text(json.dumps(REVIEW_SCHEMA))
    last = workdir / f"{tag}-answer.json"
    attached = [*refs, *([base] if base else []), picture]
    order = [f"Image {k + 1}: reference picture {k + 1}." for k in range(len(refs))]
    if base:
        order.append(f"Image {len(refs) + 1}: the picture before the edit.")
    order.append(f"Image {len(attached)}: THE PICTURE TO CHECK.")
    message = (REVIEW_RUBRIC + f"\n\nKind of picture: {kind or 'a still'}.\nAttached, in order:\n" + "\n".join(order)
               + "\n\nThe brief it was drawn from:\n<<<\n" + brief[:6000] + "\n>>>\n\nAnswer only with the JSON the schema asks for.")
    cmd = [codex_bin(), "exec", "--skip-git-repo-check", "-C", str(ws), "-c", 'model_reasoning_effort="medium"', "--output-schema", str(schema), "-o", str(last)]
    if os.environ.get("CODEX_CODE_MODE", "auto") == "off":
        cmd += ["-c", "features.code_mode=false"]
    model = os.environ.get("CODEX_REVIEW_MODEL")
    if model:
        cmd += ["-m", model]
    for p in attached:
        cmd += ["-i", str(p.resolve())]
    cmd += ["--", message]  # `-i` is greedy: end the options before the prompt
    try:
        r = runner(cmd, env={**os.environ, "CODEX_HOME": str(home)}, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=REVIEW_TIMEOUT_S)
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return None
    _keep_refreshed_login(home, copied)
    text = last.read_text() if last.is_file() else _said(getattr(r, "stdout", ""))
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        return None
    try:
        data = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    if data.get("verdict") not in ("pass", "fail") or not isinstance(data.get("findings"), list):
        return None
    findings = [f for f in data["findings"] if isinstance(f, dict)][:12]
    blockers = [f for f in findings if f.get("severity") == "blocker"]
    return {"verdict": "fail" if blockers else data["verdict"], "summary": str(data.get("summary", ""))[:600], "findings": findings, "reviewer": "codex"}


def fix_note(review: dict[str, Any]) -> str:
    """The findings of a failed self-review, as an addition to the prompt of the redraw."""
    items = [f"- {f.get('what', '').strip()} ({f.get('where', '').strip()}): {f.get('fix', '').strip()}" for f in review.get("findings", []) if f.get("severity") == "blocker"]
    return "\n\nA previous attempt at this picture had these faults; this time get them right:\n" + "\n".join(items[:8]) if items else ""


# ---------- comfy: image models on the GPU pod ----------


def _settings(raw: Any) -> dict[str, Any]:
    """The model's settings as the Studio resolved them (models.ts); anything malformed is dropped."""
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)  # noqa: E731
    if num(raw.get("steps")) and 1 <= raw["steps"] <= 100:
        out["steps"] = int(raw["steps"])
    if num(raw.get("cfg")) and 0 <= raw["cfg"] <= 30:
        out["cfg"] = float(raw["cfg"])
    if isinstance(raw.get("sampler"), str) and re.fullmatch(r"[a-z0-9_]{1,40}", raw["sampler"]):
        out["sampler"] = raw["sampler"]
    sig = raw.get("sigmas")
    if isinstance(sig, list) and 2 <= len(sig) <= 101 and all(num(v) and 0 <= v <= 1 for v in sig):
        out["sigmas"] = [float(v) for v in sig]
    if num(raw.get("resolution")) and 256 <= raw["resolution"] <= 4096:
        out["resolution"] = int(raw["resolution"])
    if num(raw.get("seed")) and raw["seed"] >= 0:
        out["seed"] = int(raw["seed"])
    return out


def image_models() -> dict[str, dict[str, Any]]:
    """workflows/image_models.json: the pod's image models, their graph and where each value goes."""
    path = POD_DIR / "workflows" / "image_models.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text())
    return {k: v for k, v in data.items() if not k.startswith("_") and isinstance(v, dict)}


def models_dir() -> Path:
    if os.environ.get("MODELS_DIR"):
        return Path(os.environ["MODELS_DIR"])
    if os.environ.get("LORA_DIR"):
        return Path(os.environ["LORA_DIR"]).parent
    return Path("/workspace/runpod-slim/ComfyUI/models")


def model_files(entry: dict[str, Any]) -> list[tuple[str, str]]:
    """(subdir, file name) of every weight the model needs, from its download list."""
    listing = POD_DIR / str(entry.get("files") or "")
    if not listing.is_file():
        return []
    out = []
    for line in listing.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        subdir, _, url = line.partition("\t")
        out.append((subdir.strip(), url.strip().rsplit("/", 1)[-1]))
    return out


def missing_files(entry: dict[str, Any], base: Path | None = None) -> list[str]:
    base = base or models_dir()
    files = model_files(entry)
    if not files:
        return ["(no download list)"]
    missing = []
    for subdir, name in files:
        # unet and diffusion_models are the same folder type to ComfyUI
        dirs = [subdir] + (["unet"] if subdir == "diffusion_models" else ["diffusion_models"] if subdir == "unet" else [])
        if not any((base / d / name).is_file() and (base / d / name).stat().st_size > 1_000_000 for d in dirs):
            missing.append(f"{subdir}/{name}")
    return missing


def comfy_backends(http: Any = requests) -> list[str]:
    """The image models this pod can draw now (comfy:<id>): ComfyUI answers and every weight is on disk."""
    models = image_models()
    if not models:
        return []
    try:
        if not http.get(f"{COMFY_URL}/system_stats", timeout=5).ok:
            return []
    except requests.RequestException:
        return []
    return [f"comfy:{k}" for k, v in models.items() if not missing_files(v)]


def _combo(spec: Any) -> list[str] | None:
    if isinstance(spec, list) and spec and isinstance(spec[0], list):
        return [str(x) for x in spec[0]]
    if isinstance(spec, list) and spec and spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return [str(x) for x in spec[1].get("options", [])]
    return None


def comfy_preflight(graph: dict[str, Any], http: Any) -> None:
    """Before queueing: every node class exists in this ComfyUI and every model file its loaders name is there."""
    infos: dict[str, Any] = {}
    missing_nodes = []
    for cls in sorted({n["class_type"] for n in graph.values()}):
        res = http.get(f"{COMFY_URL}/object_info/{cls}", timeout=30)
        info = (res.json() or {}).get(cls) if res.ok else None
        if not info:
            missing_nodes.append(cls)
        else:
            infos[cls] = info
    if missing_nodes:
        raise PaintError(f"ComfyUI on the pod lacks the nodes {', '.join(missing_nodes)}: Qwen-Image 2.1 needs a ComfyUI from September 2026 or later (a newer RUNPOD_POD_IMAGE)")
    problems = []
    for nid, node in graph.items():
        spec = {**((infos[node["class_type"]].get("input") or {}).get("required") or {}), **((infos[node["class_type"]].get("input") or {}).get("optional") or {})}
        for name, value in node["inputs"].items():
            if isinstance(value, list) or "." in name or node["class_type"] == "LoadImage":
                continue
            if name not in spec:
                problems.append(f"node {nid} ({node['class_type']}) has no input {name} here (it has {', '.join(sorted(spec)) or 'none'})")
                continue
            options = _combo(spec[name])
            if options is not None and isinstance(value, str) and value not in options:
                problems.append(f"{node['class_type']}.{name} = {value} is not in this ComfyUI (model file missing or not rescanned yet)")
    if problems:
        raise PaintError("the image workflow does not fit this ComfyUI: " + "; ".join(problems[:6]))


def _put(graph: dict[str, Any], target: Any, value: Any) -> None:
    if not target:
        return
    node, field = target
    if node not in graph:
        raise PaintError(f"image_models.json points at node {node}, which the workflow does not have")
    graph[node]["inputs"][field] = value


def comfy_upload(path: Path, http: Any) -> str:
    with open(path, "rb") as fh:
        res = http.post(f"{COMFY_URL}/upload/image", files={"image": (path.name, fh, "image/png")}, data={"overwrite": "true", "subfolder": "studio"}, timeout=120)
    if not res.ok:
        raise PaintError(f"ComfyUI refused a reference picture ({res.status_code}): {res.text[:200]}")
    data = res.json()
    return f"{data['subfolder']}/{data['name']}" if data.get("subfolder") else data["name"]


def run_comfy(model: str, prompt: str, pictures: list[Path], w: int, h: int, settings: dict[str, Any], http: Any = requests) -> Any:
    """One picture from an image model on the pod's ComfyUI: the model's API-format graph, its reference
    slots filled in order (<image1> is the first), the Studio's settings applied, then the first saved image."""
    Image = _pil()
    import random
    import uuid
    from io import BytesIO

    entry = image_models().get(model)
    if not entry:
        raise PaintError(f"this pod has no image model {model} (workflows/image_models.json)")
    missing = missing_files(entry)
    if missing:
        raise PaintError(f"{model}: model files not on the pod yet ({', '.join(missing)}); they download at boot (QWEN_IMAGE=1, /app/download_qwen_image.log)")
    if len(pictures) > int(entry.get("max_images", MAX_COMFY_PICTURES)):
        raise PaintError(f"{model} takes at most {entry.get('max_images')} pictures")
    graph = json.loads((POD_DIR / "workflows" / f"{entry['workflow']}.json").read_text())
    graph = {k: v for k, v in graph.items() if not k.startswith("_")}
    loaders = list(entry.get("image_loaders") or [])
    if len(pictures) > len(loaders):
        raise PaintError(f"{model}: the workflow has {len(loaders)} picture slots for {len(pictures)} pictures")
    target = graph.get(str(entry.get("image_target")), {})
    for i, node_id in enumerate(loaders):
        if i >= len(pictures):
            graph.pop(node_id, None)
            target.get("inputs", {}).pop(f"{entry.get('image_prefix', 'images.image_')}{i + 1}", None)
    comfy_preflight(graph, http)
    for i, pic in enumerate(pictures):
        graph[loaders[i]]["inputs"]["image"] = comfy_upload(pic, http)
    m = int(entry.get("size_multiple") or 16)
    _put(graph, entry.get("prompt"), prompt)
    _put(graph, entry.get("negative"), "")
    _put(graph, entry.get("width"), max(m, round(w / m) * m))
    _put(graph, entry.get("height"), max(m, round(h / m) * m))
    _put(graph, entry.get("seed"), settings.get("seed", random.randint(1, 2**48)))
    if "resolution" in settings:
        _put(graph, entry.get("resolution"), settings["resolution"])
    if "sampler" in settings:
        _put(graph, entry.get("sampler"), settings["sampler"])
    if "cfg" in settings:
        _put(graph, entry.get("cfg"), settings["cfg"])
    if "sigmas" in settings:
        _put(graph, entry.get("sigmas"), ", ".join(f"{s:g}" for s in settings["sigmas"]))
    if "steps" in settings and entry.get("steps"):
        _put(graph, entry.get("steps"), settings["steps"])
    res = http.post(f"{COMFY_URL}/prompt", json={"prompt": graph, "client_id": f"studio-paint-{uuid.uuid4().hex[:12]}"}, timeout=60)
    if not res.ok:
        raise PaintError(f"ComfyUI rejected the image workflow ({res.status_code}): {res.text[:500]}")
    prompt_id = (res.json() or {}).get("prompt_id")
    if not prompt_id:
        raise PaintError("ComfyUI returned no prompt_id")
    deadline = time.monotonic() + COMFY_TIMEOUT_S
    done = None
    while time.monotonic() < deadline:
        hist = http.get(f"{COMFY_URL}/history/{prompt_id}", timeout=30)
        entry_h = (hist.json() or {}).get(prompt_id) if hist.ok else None
        if entry_h:
            status = entry_h.get("status") or {}
            if status.get("status_str") == "error":
                raise PaintError(f"ComfyUI failed the picture: {json.dumps(status.get('messages', []))[:600]}")
            if entry_h.get("outputs"):
                done = entry_h
                break
        time.sleep(COMFY_POLL_S)
    if done is None:
        try:
            http.post(f"{COMFY_URL}/queue", json={"delete": [prompt_id]}, timeout=10)
        except requests.RequestException:
            pass
        raise PaintError(f"ComfyUI did not finish the picture in {COMFY_TIMEOUT_S}s (the pod's queue may hold a long take)")
    outputs = done["outputs"]
    node_out = outputs.get(str(entry.get("output_node"))) or next(iter(outputs.values()), {})
    files = node_out.get("images") or []
    if not files:
        raise PaintError("ComfyUI saved no picture")
    meta = files[0]
    view = http.get(f"{COMFY_URL}/view", params={"filename": meta["filename"], "subfolder": meta.get("subfolder", ""), "type": meta.get("type", "output")}, timeout=300)
    if not view.ok:
        raise PaintError(f"could not fetch the picture from ComfyUI ({view.status_code})")
    return Image.open(BytesIO(view.content)).convert("RGB")


# ---------- api ----------


def run_api(prompt: str, pictures: list[Path], w: int, h: int, quality: str, http: Any = requests) -> tuple[Any, int]:
    Image = _pil()
    key = os.environ.get("OPENAI_API_KEY")
    if not key:
        raise PaintError("OPENAI_API_KEY is not set on this painter")
    base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("IMAGE_MODEL", "gpt-image-2")
    rw, rh = request_size(w, h)
    headers = {"Authorization": f"Bearer {key}"}
    text = prompt + shape_hint(w, h)
    if pictures:
        files = [("image[]", (p.name, open(p, "rb"), "image/png")) for p in pictures]
        try:
            res = http.post(f"{base_url}/images/edits", headers=headers, files=files,
                            data={"model": model, "prompt": text, "size": f"{rw}x{rh}", "quality": quality, "n": "1"}, timeout=300)
        finally:
            for _, (_, fh, _) in files:
                fh.close()
    else:
        res = http.post(f"{base_url}/images/generations", headers={**headers, "Content-Type": "application/json"},
                        json={"model": model, "prompt": text, "size": f"{rw}x{rh}", "quality": quality, "n": 1}, timeout=300)
    if res.status_code == 429 or (res.status_code >= 400 and any(q in res.text.lower() for q in QUOTA_WORDS)):
        raise QuotaError(f"images API: {res.status_code} {res.text[:300]}")
    if res.status_code >= 400:
        raise PaintError(f"images API refused ({res.status_code}): {res.text[:400]}")
    data = res.json().get("data") or []
    if not data or not data[0].get("b64_json"):
        raise PaintError("images API returned no picture")
    from io import BytesIO

    return Image.open(BytesIO(base64.b64decode(data[0]["b64_json"]))).convert("RGB"), 1


# ---------- ops ----------


def _download_picture(url: str, dest: Path, http: Any) -> Path:
    with http.get(url, stream=True, timeout=300) as res:
        res.raise_for_status()
        with open(dest, "wb") as fh:
            for chunk in res.iter_content(1 << 20):
                fh.write(chunk)
    head = dest.read_bytes()[:16]
    if head.lstrip().lower().startswith((b"<!doctype", b"<html")):
        raise PaintError(f"{url} answered with an HTML page, not an image (is /media/* on the Access bypass list?)")
    # normalise to PNG so every backend reads it
    Image = _pil()
    out = dest.with_suffix(".png") if dest.suffix != ".png" else dest
    Image.open(dest).convert("RGB").save(out)
    return out


def extract_frame(video: Path, frame: int, out: Path) -> Path:
    """The exact frame `frame` (0-based) of the video, as PNG."""
    proc = subprocess.run([FFMPEG, "-v", "error", "-y", "-i", str(video), "-vf", f"select=eq(n\\,{frame})", "-vsync", "0",
                           "-frames:v", "1", str(out)], capture_output=True, text=True)
    if proc.returncode != 0 or not out.exists():
        raise PaintError(f"could not extract frame {frame}: {proc.stderr.strip()[-300:] or 'past the end of the video?'}")
    return out


def _draw(params: dict[str, Any], prompt: str, pictures: list[Path], has_base: bool, workdir: Path, http: Any,
          codex_runner: Callable[..., subprocess.CompletedProcess], tag: str) -> tuple[Any, int, tuple[int, int]]:
    w, h = params["size"]
    if params["backend"] == "codex":
        return run_codex(prompt, pictures, w, h, workdir, codex_runner, has_base=has_base, tag=tag)
    if params["backend"].startswith("comfy:"):
        drawn = run_comfy(params["backend"][len("comfy:"):], prompt, pictures, w, h, params.get("settings") or {}, http)
        return drawn, 1, drawn.size
    drawn, attempts = run_api(prompt, pictures, w, h, params["quality"], http)
    return drawn, attempts, drawn.size


def _compose(params: dict[str, Any], drawn: Any, base: Any) -> tuple[Any, Any]:
    w, h = params["size"]
    if base is not None and params.get("region"):
        img = paste_back(fit(base, w, h), drawn, params["region"])
        return img, diff_image(fit(base, w, h), img)
    img = fit(drawn, w, h)
    return img, (diff_image(fit(base, w, h), img) if base is not None else None)


def run_paint_job(params: dict[str, Any], uploader: Any, workdir: Path, http: Any = requests,
                  codex_runner: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> dict[str, Any]:
    Image = _pil()
    started = time.monotonic()
    key = params["output_key"]
    stem = key[: -len(".png")]
    out: dict[str, Any] = {"studio_job_id": params.get("studio_job_id")}
    diff = None
    checks: list[dict[str, str]] = []
    if params["op"] == "extract":
        src = workdir / "source.mp4"
        with http.get(params["video"], stream=True, timeout=600) as res:
            res.raise_for_status()
            with open(src, "wb") as fh:
                for chunk in res.iter_content(1 << 20):
                    fh.write(chunk)
        img = Image.open(extract_frame(src, params["frame"], workdir / "frame.png")).convert("RGB")
        if params.get("size"):
            img = fit(img, *params["size"])
        out["frame"] = params["frame"]
    elif params["op"] == "crop":
        base = Image.open(_download_picture(params["base"], workdir / "base", http)).convert("RGB")
        x0, y0, x1, y1 = box_px(params["crop"], *base.size)
        img = fit(base.crop((x0, y0, x1, y1)), *params["size"])
    else:
        w, h = params["size"]
        check = params.get("check") or {"review": False, "redraws": 0, "kind": ""}
        refs = [_download_picture(u, workdir / f"ref{i}", http) for i, u in enumerate(params["refs"])]
        pictures = list(refs)
        base = None
        base_path = None
        if params.get("base"):
            base_path = _download_picture(params["base"], workdir / "base", http)
            base = Image.open(base_path).convert("RGB")
            pictures.append(base_path)  # the picture being edited goes last, as the prompts say
        prompt = params["prompt"]
        drawn_count = 0
        attempts_total = 0
        review: dict[str, Any] | None = None
        for round_no in range(1 + check["redraws"]):
            drawn, attempts, drawn_size = _draw(params, prompt, pictures, base is not None, workdir, http, codex_runner, f"r{round_no}")
            drawn_count += attempts
            attempts_total += attempts
            img, diff = _compose(params, drawn, base)
            checks = auto_checks(img, drawn_size=None if params.get("region") else drawn_size, target=(w, h), kind=check["kind"], base=base, region=params.get("region"))
            review = None
            if check["review"]:
                shot = workdir / f"check{round_no}.png"
                img.save(shot)
                review = review_with_codex(shot, params["prompt"], refs, workdir, kind=check["kind"], base=base_path, runner=codex_runner, tag=f"review{round_no}")
            hard_fail = any(c["level"] == "fail" for c in checks)
            if not hard_fail and (review is None or review["verdict"] == "pass"):
                break
            if round_no < check["redraws"]:
                note = fix_note(review) if review else ""
                note += "".join(f"\n- {c['message']}" for c in checks if c["level"] == "fail")
                prompt = params["prompt"] + (note if note.strip() else "")
        out.update(backend=params["backend"], attempts=attempts_total, drawn=drawn_count, rounds=round_no + 1)
        if review is not None:
            out["review"] = review
    if params["op"] != "paint":
        checks = auto_checks(img, drawn_size=None, target=img.size)
    if checks:
        out["checks"] = checks
    full = workdir / "out.png"
    img.save(full)
    prev = workdir / "preview.jpg"
    preview(img).save(prev, quality=85)
    out["url"] = uploader.upload(full, key, "image/png")
    out["preview_url"] = uploader.upload(prev, f"{stem}.preview.jpg", "image/jpeg")
    if diff is not None:
        dpath = workdir / "diff.jpg"
        preview(diff).save(dpath, quality=85)
        out["diff_url"] = uploader.upload(dpath, f"{stem}.diff.jpg", "image/jpeg")
    out.update(width=img.width, height=img.height, seconds=round(time.monotonic() - started, 1))
    return out


def handler(raw: dict[str, Any], uploader: Any, http: Any = requests) -> dict[str, Any]:
    """One job: {error} on failure; `quota: …` errors tell the Studio to stop painting."""
    try:
        params = validate_paint_input(raw)
        with tempfile.TemporaryDirectory(prefix="paint-") as tmp:
            return run_paint_job(params, uploader, Path(tmp), http=http)
    except QuotaError as exc:
        return {"error": f"quota: {exc}"}
    except PaintError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}


# ---------- codex login (device code) ----------


URL_RE = re.compile(r"https://\S+")
CODE_RE = re.compile(r"\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


class CodexLogin:
    """`codex login --device-auth` on the painter, with the code and the URL the
    user opens in a browser, and the login status after."""

    def __init__(self, spawn: Callable[..., Any] = subprocess.Popen, runner: Callable[..., Any] = subprocess.run) -> None:
        self.spawn = spawn
        self.runner = runner
        self.lock = threading.Lock()
        self.proc: Any = None
        self.state: dict[str, Any] = {"state": "idle"}

    def _env(self) -> dict[str, str]:
        home = codex_home()
        home.mkdir(parents=True, exist_ok=True)
        return {**os.environ, "CODEX_HOME": str(home)}

    def status(self) -> dict[str, Any]:
        binary = codex_bin()
        installed = bool(shutil.which(binary) or Path(binary).is_file())
        helper = Path(binary).with_name("codex-code-mode-host") if Path(binary).is_absolute() else Path(shutil.which("codex-code-mode-host") or "")
        helper_ok = helper.is_file() if str(helper) else False
        logged_in = False
        detail = ""
        if installed:
            try:
                r = self.runner([binary, "login", "status"], env=self._env(), capture_output=True, text=True, timeout=30)
                detail = ANSI_RE.sub("", (r.stdout or "") + (r.stderr or "")).strip()[:300]
                logged_in = r.returncode == 0 and "not logged in" not in detail.lower()
            except (OSError, subprocess.TimeoutExpired) as exc:
                detail = str(exc)[:300]
        with self.lock:
            login = dict(self.state)
        if logged_in and login.get("state") == "pending":
            login["state"] = "done"
        return {"installed": installed, "code_mode_host": helper_ok, "logged_in": logged_in, "detail": detail, "bin": binary, "home": str(codex_home()), "login": login}

    def start(self) -> dict[str, Any]:
        with self.lock:
            if self.proc is not None and self.proc.poll() is None:
                return dict(self.state)
            binary = codex_bin()
            try:
                self.proc = self.spawn([binary, "login", "--device-auth"], env=self._env(), stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            except OSError as exc:
                self.state = {"state": "failed", "error": f"cannot start codex: {exc}"}
                return dict(self.state)
            self.state = {"state": "pending", "started_at": time.time(), "lines": []}
            proc = self.proc
        threading.Thread(target=self._read, args=(proc,), daemon=True).start()
        # give the CLI a moment to print the code
        deadline = time.time() + 15
        while time.time() < deadline:
            with self.lock:
                if self.state.get("code") or self.state.get("state") != "pending":
                    break
            time.sleep(0.3)
        with self.lock:
            return dict(self.state)

    def _read(self, proc: Any) -> None:
        for raw in proc.stdout:
            line = ANSI_RE.sub("", raw).strip()
            if not line:
                continue
            with self.lock:
                self.state.setdefault("lines", []).append(line)
                self.state["lines"] = self.state["lines"][-20:]
                url = URL_RE.search(line)
                if url and "url" not in self.state:
                    self.state["url"] = url.group(0).rstrip(".,)")
                code = CODE_RE.search(line)
                if code and "code" not in self.state:
                    self.state["code"] = code.group(0)
        rc = proc.wait()
        with self.lock:
            self.state["state"] = "done" if rc == 0 else "failed"
            self.state["exit"] = rc
