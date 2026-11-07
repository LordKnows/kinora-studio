"""Image jobs on the pod: paste-back, crop, extract, the Codex and API
backends (with fakes), the device-code login, and the Remake graph."""

from __future__ import annotations

import base64
import io
import json
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint  # noqa: E402

h3 = sys.modules["handler_h3_runpod"]


def png_bytes(color, size=(320, 180)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class FakeRes:
    def __init__(self, body: bytes = b"", status: int = 200, payload=None):
        self.content, self.status_code, self._payload = body, status, payload
        self.text = body.decode("latin1") if body else json.dumps(payload or {})

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(self.status_code)

    def iter_content(self, n):
        yield self.content

    def json(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeHttp:
    def __init__(self, files: dict[str, bytes]):
        self.files, self.posts = files, []

    def get(self, url, stream=False, timeout=0):
        return FakeRes(self.files[url])

    def post(self, url, **kw):
        self.posts.append((url, kw))
        return FakeRes(payload={"data": [{"b64_json": base64.b64encode(png_bytes((0, 200, 0), (1664, 960))).decode()}]})


class FakeUploader:
    def __init__(self):
        self.files = {}

    def upload(self, path, key, content_type):
        self.files[key] = Path(path).read_bytes()
        return f"https://cdn/{key}"


def test_validate():
    with pytest.raises(paint.PaintError, match="output.key"):
        paint.validate_paint_input({"op": "paint", "prompt": "a red cup"})
    with pytest.raises(paint.PaintError, match="region needs a base"):
        paint.validate_paint_input({"op": "paint", "prompt": "a red cup", "region": {"x": 0, "y": 0, "w": 0.5, "h": 0.5}, "output": {"key": "a.png"}})
    with pytest.raises(paint.PaintError, match="at most 5"):
        paint.validate_paint_input({"op": "paint", "prompt": "a red cup", "refs": [f"https://x/{i}.png" for i in range(5)], "base": "https://x/b.png", "output": {"key": "a.png"}})
    with pytest.raises(paint.PaintError, match="inside the picture"):
        paint.validate_paint_input({"op": "crop", "base": "https://x/b.png", "crop": {"x": 0.8, "y": 0, "w": 0.5, "h": 1}, "output": {"key": "a.png"}})
    p = paint.validate_paint_input({"op": "extract", "video": "https://x/v.mp4", "frame": 12, "output": {"key": "f.png"}})
    assert p["frame"] == 12


def test_paste_back_keeps_everything_outside_the_region():
    base = Image.new("RGB", (400, 200), (10, 20, 30))
    edited = Image.new("RGB", (800, 400), (250, 0, 0))
    out = paint.paste_back(base, edited, {"x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5})
    assert out.getpixel((10, 10)) == (10, 20, 30)
    assert out.getpixel((399, 199)) == (10, 20, 30)
    assert out.getpixel((99, 100)) == (10, 20, 30)  # just outside the box: exact
    assert out.getpixel((200, 100))[0] > 200  # inside: the edit


def test_fit_covers_the_canvas():
    img = paint.fit(Image.new("RGB", (1000, 1000)), 1344, 768)
    assert img.size == (1344, 768)


def fake_codex(png: bytes | None, *, refresh: bool = False, stdout: str = "", aspect_first: tuple[int, int] | None = None):
    calls = []

    def run(cmd, env, **kw):
        calls.append((cmd, env))
        home = Path(env["CODEX_HOME"])
        if refresh:
            (home / "auth.json").write_text('{"tokens": "fresh"}')
        if png is not None:
            d = home / "generated_images" / "sess"
            d.mkdir(parents=True)
            body = png
            if aspect_first and len(calls) == 1:
                body = png_bytes((1, 2, 3), aspect_first)
            (d / "img.png").write_bytes(body)
        return subprocess.CompletedProcess(cmd, 0, stdout=stdout, stderr="")

    return run, calls


@pytest.fixture()
def codex_env(tmp_path, monkeypatch):
    home = tmp_path / "master"
    home.mkdir()
    (home / "auth.json").write_text('{"tokens": "old"}')
    monkeypatch.setenv("CODEX_HOME_MASTER", str(home))
    monkeypatch.setenv("CODEX_BIN", "codex")
    return home


def test_codex_paint_region_edit_copies_a_refreshed_login_back(tmp_path, codex_env):
    http = FakeHttp({"https://x/base.png": png_bytes((10, 20, 30)), "https://x/ref.png": png_bytes((200, 200, 200))})
    run, calls = fake_codex(png_bytes((250, 0, 0), (1664, 960)), refresh=True)
    params = paint.validate_paint_input({"op": "paint", "backend": "codex", "prompt": "Put the red beret back on his head.", "refs": ["https://x/ref.png"],
                                          "base": "https://x/base.png", "region": {"x": 0.4, "y": 0.0, "w": 0.3, "h": 0.4}, "size": "1344x768", "output": {"key": "p/frames/a.png"}})
    up = FakeUploader()
    work = tmp_path / "w"
    work.mkdir()
    out = paint.run_paint_job(params, up, work, http=http, codex_runner=run)
    assert out["width"] == 1344 and out["height"] == 768 and out["backend"] == "codex"
    assert set(up.files) == {"p/frames/a.png", "p/frames/a.preview.jpg", "p/frames/a.diff.jpg"}
    img = Image.open(io.BytesIO(up.files["p/frames/a.png"]))
    assert img.getpixel((10, 700)) == (10, 20, 30)  # outside the region: the base
    assert img.getpixel((700, 100))[0] > 200
    cmd = calls[0][0]
    assert cmd[:3] == ["codex", "exec", "--skip-git-repo-check"] and "--json" in cmd
    assert "referenced_image_paths" in cmd[-1] and "aspect ratio 1344:768" in cmd[-1]
    assert json.loads((codex_env / "auth.json").read_text()) == {"tokens": "fresh"}


def test_codex_retries_a_wrong_aspect_once(tmp_path, codex_env):
    http = FakeHttp({})
    run, calls = fake_codex(png_bytes((0, 0, 255), (1664, 960)), aspect_first=(1024, 1024))
    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier in a yellow raincoat, front view.", "size": "1344x768", "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=http, codex_runner=run)
    assert out["attempts"] == 2 and len(calls) == 2


def test_codex_quota_stops_painting(tmp_path, codex_env):
    run, _ = fake_codex(None, stdout=json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": "You've hit your usage limit for image generation."}}))
    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier in a yellow raincoat.", "output": {"key": "x.png"}})
    with pytest.raises(paint.QuotaError):
        paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=run)


def test_codex_without_login_says_so(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME_MASTER", str(tmp_path / "none"))
    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier in a yellow raincoat.", "output": {"key": "x.png"}})
    with pytest.raises(paint.PaintError, match="not logged in"):
        paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=lambda *a, **k: None)


def test_api_backend_posts_an_edit(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    http = FakeHttp({"https://x/base.png": png_bytes((10, 20, 30))})
    params = paint.validate_paint_input({"op": "paint", "backend": "api", "prompt": "Make it night.", "base": "https://x/base.png", "size": "1344x768", "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=http)
    url, kw = http.posts[0]
    assert url.endswith("/images/edits") and kw["data"]["model"] == "gpt-image-2" and kw["data"]["quality"] == "low"
    assert out["diff_url"].endswith("x.diff.jpg")


def test_crop_and_extract(tmp_path):
    big = Image.new("RGB", (1344, 768), (0, 0, 0))
    big.paste((255, 255, 255), (500, 250, 844, 518))
    buf = io.BytesIO()
    big.save(buf, "PNG")
    http = FakeHttp({"https://x/hero.png": buf.getvalue()})
    params = paint.validate_paint_input({"op": "crop", "base": "https://x/hero.png", "crop": {"x": 0.3, "y": 0.25, "w": 0.4, "h": 0.5}, "size": "1344x768", "output": {"key": "c.png"}})
    up = FakeUploader()
    paint.run_paint_job(params, up, tmp_path, http=http)
    assert Image.open(io.BytesIO(up.files["c.png"])).size == (1344, 768)

    video = tmp_path / "v.mp4"
    subprocess.run([paint.FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=24:duration=1", "-pix_fmt", "yuv420p", str(video)], check=True)
    http2 = FakeHttp({"https://x/v.mp4": video.read_bytes()})
    p2 = paint.validate_paint_input({"op": "extract", "video": "https://x/v.mp4", "frame": 12, "output": {"key": "f.png"}})
    work = tmp_path / "e"
    work.mkdir()
    out = paint.run_paint_job(p2, up, work, http=http2)
    assert out["frame"] == 12 and Image.open(io.BytesIO(up.files["f.png"])).size == (320, 180)
    with pytest.raises(paint.PaintError, match="could not extract"):
        work2 = tmp_path / "e2"
        work2.mkdir()
        paint.run_paint_job(paint.validate_paint_input({"op": "extract", "video": "https://x/v.mp4", "frame": 999, "output": {"key": "g.png"}}), up, work2, http=http2)


def test_device_code_login_reports_url_and_code(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_HOME_MASTER", str(tmp_path / "home"))

    class Proc:
        def __init__(self):
            self.stdout = iter(["Welcome to Codex\n", "\x1b[1mOpen https://auth.openai.com/codex/device\x1b[0m\n", "and enter this one-time code: ABCD-12345\n"])

        def poll(self):
            return None

        def wait(self):
            return 0

    login = paint.CodexLogin(spawn=lambda *a, **k: Proc(), runner=lambda *a, **k: subprocess.CompletedProcess(a, 0, stdout="Logged in using ChatGPT", stderr=""))
    state = login.start()
    deadline = time.time() + 3
    while time.time() < deadline and login.state.get("state") == "pending":
        time.sleep(0.05)
    assert login.state["url"] == "https://auth.openai.com/codex/device"
    assert login.state["code"] == "ABCD-12345"
    assert login.state["state"] == "done"
    assert state["state"] in ("pending", "done")


def test_remake_input_and_graph():
    with pytest.raises(h3.JobError, match="17n"):
        h3.validate_remake_input({"workflow": "REMAKE", "video": "https://x/v.mp4", "prompt": "retention_analysis:", "refs": ["https://x/a.png"], "frames": 100, "output": {"key": "a.mp4"}})
    with pytest.raises(h3.JobError, match="one source frame index per ref"):
        h3.validate_remake_input({"workflow": "REMAKE", "video": "https://x/v.mp4", "prompt": "retention_analysis:", "refs": ["https://x/a.png"], "pins": [1, 2], "output": {"key": "a.mp4"}})
    params = h3.validate_remake_input({"workflow": "REMAKE", "mode": "swap", "video": "https://x/v.mp4", "prompt": "subject_definitions:\nretention_analysis:\n", "refs": ["https://x/a.png", "https://x/b.png"], "pins": [12, 100], "frames": 124, "output": {"key": "a.mp4"}})
    mapping = h3.load_mapping()["REMAKE"]
    graph = h3.fill_remake_graph(h3.load_workflow("REMAKE"), mapping, {**params, "files": {"video": "src.mp4", "refs": ["a.png", "b.png"]}})
    assert graph["1"]["inputs"]["unet_name"] == "viggle_remake_swap_pruned_int8_convrot.safetensors"
    assert graph["15"]["inputs"]["sigmas"].startswith("1.0, 0.990476")
    assert graph["11"]["inputs"]["pins"] == "12, 100" and graph["11"]["inputs"]["frames"] == 124
    assert "ref_3" not in graph["11"]["inputs"] and "21" not in graph and "22" not in graph
    assert graph["9"]["inputs"]["image"] == "a.png" and graph["10"]["inputs"]["image"] == "b.png"
    # every link points at a node that is still there
    for nid, node in graph.items():
        for v in node["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                assert v[0] in graph, (nid, v)


def test_remake_status_reads_files(tmp_path, monkeypatch):
    (tmp_path / "diffusion_models").mkdir()
    (tmp_path / "diffusion_models" / "viggle_remake_edit_pruned_int8_convrot.safetensors").write_bytes(b"0" * 2_000_000)
    nodes = tmp_path / "nodes"
    nodes.mkdir()
    (nodes / "nodes.py").write_text("#")
    monkeypatch.setattr(h3, "REMAKE_NODE_DIR", str(nodes))
    st = h3.remake_status(tmp_path)
    assert st["ready"] and st["modes"] == {"edit": True, "swap": False}


def test_codex_falls_back_without_code_mode_when_its_host_is_missing(tmp_path, codex_env):
    calls = []

    def run(cmd, env, **kw):
        calls.append(cmd)
        home = Path(env["CODEX_HOME"])
        if "features.code_mode=false" not in cmd:
            msg = {"type": "item.completed", "item": {"type": "agent_message", "text": "REFUSED failed to spawn code-mode host /root/codex/bin/codex-code-mode-host: No such file or directory (os error 2)"}}
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(msg), stderr="")
        d = home / "generated_images" / "s"
        d.mkdir(parents=True)
        (d / "a.png").write_bytes(png_bytes((9, 9, 9), (1664, 960)))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier in a yellow raincoat, front view.", "size": "1344x768", "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=run)
    assert out["attempts"] == 2
    assert "features.code_mode=false" not in calls[0] and "features.code_mode=false" in calls[1]


def test_install_codex_script_is_valid_bash():
    assert subprocess.run(["bash", "-n", str(HERE / "install_codex.sh")]).returncode == 0
