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


def test_a_painter_on_runpod_says_which_pod_it_is(monkeypatch):
    fake = FakeStudio()
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-5", "box", login=FakeLogin(), http=fake)
    monkeypatch.setenv("RUNPOD_POD_ID", "cpu-pod-1")
    p.tick()
    assert fake.claims[-1]["info"]["runpodPodId"] == "cpu-pod-1"
    monkeypatch.delenv("RUNPOD_POD_ID")
    p.tick()
    assert "runpodPodId" not in fake.claims[-1]["info"]


def test_a_job_handed_over_again_is_not_drawn_twice():
    gate = threading.Event()
    calls = []

    def run_job(job_id, raw):
        calls.append(job_id)
        gate.wait(5)
        return {"error": "test"}

    job = {"jobId": "job_9", "input": {}}
    fake = FakeStudio(jobs=[job])
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-6", "box", slots=2, login=FakeLogin(), http=fake, run_job=run_job)
    p.tick()
    fake.jobs = [job]  # the Studio hands it over again (its answer was lost)
    p.tick()
    assert fake.claims[-1]["info"]["running"] == ["job_9"] and fake.claims[-1]["info"]["instance"] == p.instance
    gate.set()
    assert wait_for(lambda: not p.running)
    assert calls == ["job_9"]


def test_on_runpod_every_pod_is_its_own_painter(tmp_path, monkeypatch):
    monkeypatch.setenv("STUDIO_URL", "https://studio.test")
    monkeypatch.setenv("PAINTER_TOKEN", "tok")
    monkeypatch.setenv("PAINTER_STATE_DIR", str(tmp_path))
    monkeypatch.delenv("PAINTER_ID", raising=False)
    monkeypatch.setenv("RUNPOD_POD_ID", "abc123")
    assert painter.from_env().id == "pod-abc123"
    assert painter.from_env(on_pod=True).id == "gpu-pod-abc123"
    monkeypatch.delenv("RUNPOD_POD_ID")
    assert painter.from_env().id == painter.painter_id(tmp_path)


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


def test_an_api_key_for_qwen_is_advertised(monkeypatch):
    monkeypatch.setenv("TOKENSAIL_API_KEY", "sk-tokensail-0000test")
    fake = FakeStudio()
    p = painter.Painter(painter.Studio("https://studio.test", "tok", http=fake), "box-1", "box", slots=1, login=FakeLogin(logged_in=False), http=fake)
    p.tick()
    info = fake.claims[0]["info"]
    assert "qwen" in info["backends"] and "codex" not in info["backends"] and "mirror_refs" in info["features"]


def test_the_uploader_keeps_the_signed_link_for_a_vendor():
    class Studio:
        def post(self, path, body):
            key = body["keys"][0]
            return {"uploads": [{"key": key, "putUrl": f"https://r2.test/put/{key}", "publicUrl": f"https://studio.test/media/{key}",
                                 **({"fetchUrl": f"https://acct.r2.cloudflarestorage.com/studio/{key}?sig"} if ".ref" in key else {})}]}

    class Http:
        def put(self, url, data=None, headers=None, timeout=0):
            return Res(200)

    up = painter.PresignedUploader(Studio(), "job_1", "box-1", http=Http())
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".jpg") as fh:
        assert up.upload(Path(fh.name), "projects/p/images/job_1.ref0.jpg", "image/jpeg") == "https://studio.test/media/projects/p/images/job_1.ref0.jpg"
        up.upload(Path(fh.name), "projects/p/images/job_1.png", "image/png")
    assert up.fetch_urls == {"projects/p/images/job_1.ref0.jpg": "https://acct.r2.cloudflarestorage.com/studio/projects/p/images/job_1.ref0.jpg?sig"}
