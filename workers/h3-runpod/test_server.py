"""The pod job server, exercised over real HTTP on a local port."""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from server import JobServer


def call(port: int, method: str, path: str, body: dict | None = None, token: str | None = "t0k") -> tuple[int, dict]:
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", method=method)
    if token:
        req.add_header("X-Studio-Token", token)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=5) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read() or b"{}")


@pytest.fixture
def running():
    posted: list[tuple[str, dict]] = []

    def fake_post(url, json=None, timeout=0):  # noqa: A002
        posted.append((url, json))

        class R:
            status_code = 200

        return R()

    def run_video(inp):
        time.sleep(0.05)
        if inp.get("boom"):
            raise RuntimeError("kaboom")
        return {"url": f"https://r2/{inp['output']['key']}", "execution_ms": 50}

    def run_assemble(inp):
        return {"url": "https://r2/export.mp4", "duration_s": 1.0}

    server = JobServer(run_video, run_assemble, token="t0k", health=lambda: {"ok": True, "comfy": {"ok": True}}, post=fake_post)
    httpd = server.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield port, posted
    httpd.shutdown()


def wait_done(port: int, job_id: str) -> dict:
    for _ in range(100):
        status, job = call(port, "GET", f"/status/{job_id}")
        assert status == 200
        if job["status"] in ("COMPLETED", "FAILED", "CANCELLED"):
            return job
        time.sleep(0.02)
    raise AssertionError("job never finished")


def test_requires_token(running):
    port, _ = running
    assert call(port, "GET", "/health", token=None)[0] == 401
    assert call(port, "GET", "/health", token="wrong")[0] == 401
    assert call(port, "GET", "/health")[1]["ok"] is True


def test_run_completes_and_posts_webhook(running):
    port, posted = running
    status, job = call(port, "POST", "/run", {"input": {"output": {"key": "p/t.mp4"}}, "webhook": "https://studio/hook?id=t"})
    assert status == 200 and job["status"] == "IN_QUEUE"
    done = wait_done(port, job["id"])
    assert done["status"] == "COMPLETED"
    assert done["output"]["url"] == "https://r2/p/t.mp4"
    assert done["executionTime"] >= 50
    time.sleep(0.05)
    assert posted and posted[0][0] == "https://studio/hook?id=t"
    assert posted[0][1]["status"] == "COMPLETED"


def test_failure_is_reported(running):
    port, _ = running
    _, job = call(port, "POST", "/run", {"input": {"boom": True, "output": {"key": "x.mp4"}}})
    done = wait_done(port, job["id"])
    assert done["status"] == "FAILED"
    assert "kaboom" in done["error"]


def test_assemble_and_cancel(running):
    port, _ = running
    _, a = call(port, "POST", "/assemble", {"input": {}})
    assert wait_done(port, a["id"])["output"]["url"] == "https://r2/export.mp4"
    # queue two slow jobs; cancel the second while the first runs
    _, first = call(port, "POST", "/run", {"input": {"output": {"key": "1.mp4"}}})
    _, second = call(port, "POST", "/run", {"input": {"output": {"key": "2.mp4"}}})
    status, cancelled = call(port, "POST", f"/cancel/{second['id']}")
    assert status == 200 and cancelled["status"] in ("CANCELLED", "IN_PROGRESS", "COMPLETED")
    wait_done(port, first["id"])
    assert call(port, "GET", "/status/nope")[0] == 404


def test_cancel_running_job_interrupts_comfy_and_ends_cancelled():
    interrupts: list[int] = []

    def run_video(inp, should_cancel=None):
        for _ in range(200):
            if should_cancel and should_cancel():
                return {"error": "cancelled"}
            time.sleep(0.01)
        return {"url": "https://r2/late.mp4"}

    server = JobServer(run_video, lambda inp, c=None: {}, token="t0k", interrupt=lambda: interrupts.append(1), post=lambda *a, **k: None)
    httpd = server.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        _, job = call(port, "POST", "/run", {"input": {"output": {"key": "x.mp4"}}})
        for _ in range(100):
            if call(port, "GET", f"/status/{job['id']}")[1]["status"] == "IN_PROGRESS":
                break
            time.sleep(0.01)
        status, answer = call(port, "POST", f"/cancel/{job['id']}")
        assert status == 200 and answer.get("cancelRequested") is True
        assert interrupts == [1]
        assert wait_done(port, job["id"])["status"] == "CANCELLED"
    finally:
        httpd.shutdown()


def test_status_carries_the_runner_progress():
    def run_video(inp, should_cancel=None, report=None):
        report({"stage": "sampling", "step": 3, "total": 8, "percent": 38})
        time.sleep(0.2)
        return {"url": "https://r2/x.mp4"}

    server = JobServer(run_video, lambda inp: {}, token="t0k", post=lambda *a, **k: None)
    httpd = server.serve("127.0.0.1", 0)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        _, job = call(port, "POST", "/run", {"input": {"output": {"key": "x.mp4"}}})
        progress = None
        for _ in range(50):
            progress = call(port, "GET", f"/status/{job['id']}")[1].get("progress")
            if progress:
                break
            time.sleep(0.01)
        assert progress and progress["stage"] == "sampling" and progress["step"] == 3 and "at" in progress
        assert wait_done(port, job["id"])["status"] == "COMPLETED"
    finally:
        httpd.shutdown()
