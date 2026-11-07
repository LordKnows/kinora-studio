"""What a painter draws: paste-back, crop, extract, the Codex and API
backends (with fakes), aspect handling, the pixel checks, the self-review
with one redraw, and the device-code login."""

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
    # the pictures go in as attachments, in order (ref first, the picture to edit last), and the ratio is one the model knows
    pics = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-i"]
    assert len(pics) == 2 and pics[0].endswith("ref0.png") and pics[1].endswith("base.png")
    # `-i` takes several values: the prompt must come after `--` or Codex reads it as a picture
    assert cmd[-2] == "--" and cmd.index("--") > max(i for i, a in enumerate(cmd) if a == "-i")
    assert "16:9 aspect ratio" in cmd[-1] and "Image 2: the picture to edit." in cmd[-1]
    assert "checks" not in out or all(c["id"] != "cropped" for c in out["checks"])  # a region edit is pasted, not cropped
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


def test_shape_hint_names_a_ratio_the_model_knows():
    assert paint.nearest_ratio(1344, 768) == (16, 9)
    assert paint.nearest_ratio(1008, 1344) == (3, 4)
    assert paint.nearest_ratio(1024, 1024) == (1, 1)
    assert "portrait" in paint.shape_hint(1008, 1344) and "3:4 aspect ratio" in paint.shape_hint(1008, 1344)


def test_a_close_aspect_is_kept_and_its_crop_reported(tmp_path, codex_env):
    run, calls = fake_codex(png_bytes((90, 120, 150), (1536, 1024)))  # 3:2 for a 16:9 frame: 14% off, redrawn once
    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier crosses a wet square at dusk.", "size": "1344x768", "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=run)
    assert len(calls) == 2 and out["drawn"] == 2
    crop = next(c for c in out["checks"] if c["id"] == "cropped")
    assert crop["level"] == "warn" and "top and bottom" in crop["message"]

    run2, calls2 = fake_codex(png_bytes((90, 120, 150), (1672, 941)))  # what "16:9" gets: kept at once
    out2 = paint.run_paint_job(params, FakeUploader(), tmp_path / "b", http=FakeHttp({}), codex_runner=run2) if (tmp_path / "b").mkdir() is None else None
    assert len(calls2) == 1 and out2["drawn"] == 1 and not any(c["id"] == "cropped" and c["level"] != "warn" for c in out2.get("checks", []))


def test_pixel_checks():
    flat = Image.new("RGB", (1344, 768), (128, 128, 128))
    assert any(c["id"] == "blank" and c["level"] == "fail" for c in paint.auto_checks(flat, drawn_size=None, target=(1344, 768)))
    noisy = Image.effect_noise((1344, 768), 60).convert("RGB")
    assert paint.auto_checks(noisy, drawn_size=None, target=(1344, 768)) == []
    boxed = noisy.copy()
    boxed.paste((0, 0, 0), (0, 0, 1344, 60))
    boxed.paste((0, 0, 0), (0, 708, 1344, 768))
    border = [c for c in paint.auto_checks(boxed, drawn_size=None, target=(1344, 768)) if c["id"] == "border"]
    assert border and "top" in border[0]["message"] and "bottom" in border[0]["message"] and "left" not in border[0]["message"]
    pillar = noisy.copy()
    pillar.paste((10, 10, 10), (0, 0, 80, 768))
    side = [c for c in paint.auto_checks(pillar, drawn_size=None, target=(1344, 768)) if c["id"] == "border"]
    assert side and "left" in side[0]["message"] and "right" not in side[0]["message"]
    other = Image.effect_noise((1344, 768), 60).convert("RGB").transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    scope = [c for c in paint.auto_checks(other, drawn_size=None, target=(1344, 768), base=Image.new("RGB", (1344, 768), (20, 20, 20))) if c["id"] == "edit_scope"]
    assert scope and scope[0]["level"] == "warn"
    sheet = Image.new("RGB", (1008, 1344), (200, 200, 200))
    sheet.paste(Image.effect_noise((400, 1000), 80).convert("RGB"), (300, 200))
    assert not any(c["id"] == "busy_background" for c in paint.auto_checks(sheet, drawn_size=None, target=(1008, 1344), kind="element_sheet"))
    assert any(c["id"] == "busy_background" for c in paint.auto_checks(Image.effect_noise((1008, 1344), 80).convert("RGB"), drawn_size=None, target=(1008, 1344), kind="element_sheet"))


def test_self_review_redraws_a_blocker_once_with_the_findings(tmp_path, codex_env):
    draws, reviews = [], []

    def run(cmd, env, **kw):
        home = Path(env["CODEX_HOME"])
        if "--output-schema" in cmd:
            reviews.append(cmd)
            verdict = {"verdict": "fail", "summary": "six fingers", "findings": [{"code": "anatomy", "severity": "blocker", "where": "her left hand", "what": "six fingers", "fix": "five fingers on her left hand"}]} if len(reviews) == 1 else {"verdict": "pass", "summary": "ok", "findings": []}
            Path(cmd[cmd.index("-o") + 1]).write_text(json.dumps(verdict))
            assert cmd[-2] == "--"
            assert cmd[cmd.index("-i", len(cmd) - 4) + 1].endswith(".png")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        draws.append(cmd[-1])
        d = home / "generated_images" / "s"
        d.mkdir(parents=True)
        (d / "a.png").write_bytes(png_bytes((30 + len(draws), 60, 90), (1672, 941)))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier waves with her left hand.", "size": "1344x768", "check": {"review": True, "redraws": 1, "kind": "shot_first"}, "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=run)
    assert len(draws) == 2 and len(reviews) == 2 and out["drawn"] == 2 and out["rounds"] == 2
    assert "five fingers on her left hand" in draws[1] and "five fingers" not in draws[0]
    assert out["review"]["verdict"] == "pass" and out["review"]["reviewer"] == "codex"


def test_self_review_failure_is_kept_when_no_redraw_is_left(tmp_path, codex_env):
    def run(cmd, env, **kw):
        home = Path(env["CODEX_HOME"])
        if "--output-schema" in cmd:
            Path(cmd[cmd.index("-o") + 1]).write_text(json.dumps({"verdict": "pass", "summary": "", "findings": [{"code": "text", "severity": "blocker", "where": "bottom", "what": "a caption", "fix": "no caption"}]}))
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        d = home / "generated_images" / "s"
        d.mkdir(parents=True)
        (d / "a.png").write_bytes(png_bytes((40, 60, 90), (1672, 941)))
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    params = paint.validate_paint_input({"op": "paint", "prompt": "A courier waves.", "size": "1344x768", "check": {"review": True, "redraws": 0}, "output": {"key": "x.png"}})
    out = paint.run_paint_job(params, FakeUploader(), tmp_path, http=FakeHttp({}), codex_runner=run)
    # a blocker makes it a fail whatever the verdict field said
    assert out["drawn"] == 1 and out["review"]["verdict"] == "fail"
