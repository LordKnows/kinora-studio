"""The painter loop against a fake Studio: heartbeat and claim, presigned
uploads, the answer, the Codex login command, and a lost lease."""

from __future__ import annotations

import io
import subprocess
import sys
import threading
import time
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint  # noqa: E402
import painter  # noqa: E402


class Res:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code, self._payload, self.text, self.reason = status, payload, text or "", "x"

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


class FakeStudio:
    """Answers the painter endpoints like the Worker does, and records what came in."""

    def __init__(self, jobs=None, commands=None):
        self.jobs = list(jobs or [])
        self.commands = list(commands or [])
        self.claims, self.uploads, self.done, self.puts = [], [], [], {}
        self.deny_done = False

    def post(self, url, json=None, timeout=0, headers=None):
        assert headers["Authorization"] == "Bearer tok"
        path = url.split("https://studio.test", 1)[1]
        if path == "/api/painter/claim":
            self.claims.append(json)
            jobs, self.jobs = self.jobs[: json["want"]], self.jobs[json["want"]:]
            cmds, self.commands = self.commands, []
            return Res(200, {"jobs": jobs, "commands": cmds, "pollMs": 1000})
        if path.endswith("/uploads"):
            self.uploads.append(json)
            return Res(200, {"uploads": [{"key": k, "putUrl": f"https://r2.test/put/{k}", "publicUrl": f"https://cdn.test/{k}"} for k in json["keys"]]})
        if path.endswith("/done"):
            if self.deny_done:
                return Res(403, {"error": {"code": "forbidden", "message": "this painter does not hold the job"}})
            self.done.append((path, json))
            return Res(200, {"status": "completed"})
        return Res(404, {"error": {"message": "no"}})

    def put(self, url, data=None, headers=None, timeout=0):
        self.puts[url] = data.read()
        return Res(200, {})

    def get(self, url, stream=False, timeout=0):
        buf = io.BytesIO()
        Image.new("RGB", (640, 360), (20, 40, 60)).save(buf, "PNG")

        class R:
            def __enter__(self_):
                return self_

            def __exit__(self_, *a):
                return False

            def raise_for_status(self_):
                return None

            def iter_content(self_, n):
                yield buf.getvalue()

        return R()


class FakeLogin:
    def __init__(self, logged_in=True):
        self.state = {"state": "idle"}
        self.logged_in = logged_in
        self.started = 0

    def status(self):
        return {"installed": True, "logged_in": self.logged_in, "code_mode_host": True}

    def start(self):
        self.started += 1
        self.state = {"state": "pending", "url": "https://auth.openai.com/codex/device", "code": "ABCD-1234"}
        return dict(self.state)


def wait_for(cond, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_claims_draws_uploads_and_answers():
    fake = FakeStudio(jobs=[{"jobId": "job_1", "input": {"op": "crop", "base": "https://cdn.test/hero.png", "crop": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}, "size": "1344x768", "output": {"key": "projects/p/images/job_1.png"}}}])
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-1", "box", slots=2, login=FakeLogin(logged_in=True), http=fake)
    assert p.tick() == 1000
    claim = fake.claims[0]
    assert claim["painterId"] == "box-1" and claim["want"] == 2 and claim["info"]["backends"] == ["codex"] and claim["info"]["onPod"] is False
    assert wait_for(lambda: fake.done)
    path, body = fake.done[0]
    assert path == "/api/painter/jobs/job_1/done" and body["painterId"] == "box-1"
    assert body["output"]["url"] == "https://cdn.test/projects/p/images/job_1.png" and body["output"]["width"] == 1344
    assert {u["keys"][0] for u in fake.uploads} == {"projects/p/images/job_1.png", "projects/p/images/job_1.preview.jpg"}
    assert Image.open(io.BytesIO(fake.puts["https://r2.test/put/projects/p/images/job_1.png"])).size == (1344, 768)
    assert wait_for(lambda: not p.running)
    # the next heartbeat no longer lists it as running
    p.tick()
    assert fake.claims[-1]["info"]["running"] == []


def test_no_codex_login_no_codex_jobs_and_the_login_command_starts_one():
    login = FakeLogin(logged_in=False)
    fake = FakeStudio(commands=[{"id": "cmd_1", "type": "codex_login", "at": 0}])
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-2", "box", login=login, http=fake)
    p.tick()
    assert fake.claims[0]["info"]["backends"] == []
    assert wait_for(lambda: login.started == 1)
    p.tick()
    assert fake.claims[-1]["info"]["login"]["code"] == "ABCD-1234"


def test_a_job_whose_lease_was_lost_is_dropped_quietly():
    fake = FakeStudio(jobs=[{"jobId": "job_2", "input": {}}])
    fake.deny_done = True
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-3", "box", login=FakeLogin(), http=fake,
                        run_job=lambda job_id, raw: {"error": "bad input"})
    p.tick()
    assert wait_for(lambda: not p.running)
    assert "does not hold the job" in p.last_error


def test_an_access_login_page_is_named():
    class AccessWall(FakeStudio):
        def post(self, url, json=None, timeout=0, headers=None):
            return Res(403, None, text="<html><title>Sign in ・ Cloudflare Access</title></html>")

    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=AccessWall()), "box-4", "box", login=FakeLogin())
    try:
        p.tick()
    except painter.StudioError as exc:
        assert "Access bypass" in str(exc)
    else:
        raise AssertionError("expected a StudioError")


def test_painter_id_is_stable(tmp_path):
    a = painter.painter_id(tmp_path)
    assert a == painter.painter_id(tmp_path) and (tmp_path / "painter-id").read_text() == a
    assert painter.painter_id(tmp_path, "gpu-pod-abc") == "gpu-pod-abc"


def test_pod_starts_a_painter_only_when_asked(monkeypatch):
    monkeypatch.setenv("PAINTER_ON_POD", "0")
    monkeypatch.setenv("STUDIO_URL", "https://studio.test")
    assert painter.start_in_background() is None
    monkeypatch.delenv("PAINTER_ON_POD")
    monkeypatch.delenv("STUDIO_URL")
    assert painter.start_in_background() is None


def test_install_codex_script_picks_the_arch():
    script = (HERE / "install_codex.sh").read_text()
    assert "uname -m" in script and "aarch64-unknown-linux-musl" in script
    assert subprocess.run(["bash", "-n", str(HERE / "install_codex.sh")]).returncode == 0
    assert threading.active_count() >= 1
