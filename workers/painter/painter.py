"""The Studio's painter: draws pictures away from the GPU.

Run it on any small always-on machine — a RunPod CPU pod, a VPS, a spare
computer — and the Studio's character sheets, first and last frames, region
edits, style frames, crops and frame extracts are made there, before the GPU
pod is ever started. The GPU pod runs one too (server.py), as the fallback
while it is up.

It only calls out: every few seconds it POSTs a heartbeat to the Studio
(/api/painter/claim) saying what it can draw now, and the answer hands it
jobs and commands (start the Codex device-code login). Results go straight to
R2 through presigned PUTs (/api/painter/jobs/<id>/uploads) and are reported
with /api/painter/jobs/<id>/done. No inbound port, no R2 keys on the box.

Environment:
    STUDIO_URL          https://studio.example.com (required)
    PAINTER_TOKEN       the Worker's PAINTER_TOKEN (or STUDIO_WORKER_TOKEN) (required)
    PAINTER_NAME        shown on the Machine page (default: the host name)
    PAINTER_SLOTS       pictures at once (default 2)
    PAINTER_STATE_DIR   where the painter id and the Codex login live (default ~/.cinema-painter)
    OPENAI_API_KEY      optional: the images API backend
    CODEX_BIN, CODEX_HOME_MASTER, CODEX_PAINT_MODEL, CODEX_REVIEW_MODEL  optional
"""

from __future__ import annotations

import os
import socket
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import requests

import paint

VERSION = "2026.11.1"
UA = f"CinemaStudioPainter/{VERSION} (+python-requests)"


class StudioError(Exception):
    def __init__(self, status: int, message: str, payload: Any = None) -> None:
        super().__init__(f"{status}: {message}")
        self.status = status
        self.payload = payload


class Studio:
    """The few Studio endpoints a painter calls, with its token."""

    def __init__(self, url: str, token: str, http: Any = None) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.http = http or requests.Session()

    def post(self, path: str, body: dict[str, Any], timeout: int = 60) -> dict[str, Any]:
        res = self.http.post(f"{self.url}{path}", json=body, timeout=timeout,
                             headers={"Authorization": f"Bearer {self.token}", "User-Agent": UA, "Accept": "application/json"})
        try:
            payload = res.json()
        except ValueError:
            payload = {"error": {"message": (res.text or "")[:300]}}
        if res.status_code >= 400:
            err = payload.get("error") if isinstance(payload, dict) else None
            msg = err.get("message") if isinstance(err, dict) else str(payload)[:300]
            if res.status_code in (401, 403) and "<html" in (res.text or "").lower()[:400]:
                msg = "Cloudflare Access answered instead of the Studio: add /api/painter/* to the Access bypass application"
            raise StudioError(res.status_code, msg or res.reason, payload)
        return payload if isinstance(payload, dict) else {}


class PresignedUploader:
    """paint.run_paint_job's uploader: asks the Studio for a presigned PUT per file."""

    def __init__(self, studio: Studio, job_id: str, painter_id: str, http: Any = requests) -> None:
        self.studio, self.job_id, self.painter_id, self.http = studio, job_id, painter_id, http

    def upload(self, path: Path, key: str, content_type: str) -> str:
        got = self.studio.post(f"/api/painter/jobs/{self.job_id}/uploads", {"painterId": self.painter_id, "keys": [key]})
        up = got["uploads"][0]
        with open(path, "rb") as fh:
            res = self.http.put(up["putUrl"], data=fh, headers={"Content-Type": content_type}, timeout=300)
        if res.status_code >= 400:
            raise paint.PaintError(f"uploading {key} failed: {res.status_code} {(res.text or '')[:200]}")
        return up["publicUrl"]


def painter_id(state_dir: Path, explicit: str | None = None) -> str:
    """A stable id per machine (kept in the state dir), so a restart is the same painter."""
    if explicit:
        return explicit
    f = state_dir / "painter-id"
    try:
        if f.is_file() and f.read_text().strip():
            return f.read_text().strip()
        state_dir.mkdir(parents=True, exist_ok=True)
        pid = f"{socket.gethostname().split('.')[0][:30]}-{uuid.uuid4().hex[:8]}"
        f.write_text(pid)
        return pid
    except OSError:
        return f"{socket.gethostname().split('.')[0][:30]}-{uuid.uuid4().hex[:8]}"


class Painter:
    def __init__(self, studio: Studio, pid: str, name: str, slots: int = 2, on_pod: bool = False,
                 login: paint.CodexLogin | None = None, run_job: Callable[..., dict[str, Any]] | None = None,
                 http: Any = requests) -> None:
        self.studio, self.id, self.name, self.slots, self.on_pod = studio, pid, name, max(1, slots), on_pod
        self.login = login or paint.CodexLogin()
        self.http = http
        self.run_job = run_job or self._run_paint
        self.running: dict[str, threading.Thread] = {}
        self.lock = threading.Lock()
        self._codex: dict[str, Any] | None = None
        self._codex_at = 0.0
        self.last_error = ""

    # ---- what it can do ----

    def codex_status(self, force: bool = False) -> dict[str, Any]:
        """`codex login status` spawns a process: ask once a minute, or right after a login."""
        login_state = self.login.state.get("state")
        if force or self._codex is None or time.time() - self._codex_at > 60 or login_state == "pending":
            self._codex = self.login.status()
            self._codex_at = time.time()
        return self._codex

    def info(self) -> dict[str, Any]:
        codex = self.codex_status()
        backends = (["codex"] if codex.get("logged_in") else []) + (["api"] if os.environ.get("OPENAI_API_KEY") else [])
        with self.lock:
            running = list(self.running)
        login = {k: v for k, v in self.login.state.items() if k in ("state", "url", "code", "lines", "error")}
        return {
            "version": VERSION, "host": socket.gethostname()[:120], "backends": backends, "ops": ["paint", "crop", "extract"],
            "slots": self.slots, "running": running, "onPod": self.on_pod,
            **({"runpodPodId": os.environ["RUNPOD_POD_ID"]} if os.environ.get("RUNPOD_POD_ID") else {}),
            "codex": {k: codex.get(k) for k in ("installed", "logged_in", "code_mode_host", "detail", "home", "bin")},
            **({"login": login} if login.get("state") not in (None, "idle") else {}),
            **({"lastError": self.last_error[:600]} if self.last_error else {}),
        }

    # ---- one heartbeat ----

    def tick(self) -> int:
        """Heartbeat + claim; start what it was handed. Returns the ms to wait before the next one."""
        with self.lock:
            free = self.slots - len(self.running)
        answer = self.studio.post("/api/painter/claim", {"painterId": self.id, "name": self.name, "want": max(0, free), "info": self.info()})
        for cmd in answer.get("commands") or []:
            if cmd.get("type") == "codex_login":
                threading.Thread(target=self._login, name="codex-login", daemon=True).start()
        for job in answer.get("jobs") or []:
            t = threading.Thread(target=self._run, args=(job["jobId"], job["input"]), name=f"job-{job['jobId']}", daemon=True)
            with self.lock:
                self.running[job["jobId"]] = t
            t.start()
        return int(answer.get("pollMs") or 5000)

    def _login(self) -> None:
        self.login.start()
        # come back to `codex login status` as soon as the user approves
        deadline = time.time() + 15 * 60
        while time.time() < deadline and self.login.state.get("state") == "pending":
            time.sleep(3)
        self.codex_status(force=True)

    # ---- one job ----

    def _run_paint(self, job_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        uploader = PresignedUploader(self.studio, job_id, self.id, self.http)
        return paint.handler(raw, uploader, http=self.http)

    def _run(self, job_id: str, raw: dict[str, Any]) -> None:
        try:
            out = self.run_job(job_id, raw)
            body = {"painterId": self.id, **({"error": out["error"]} if "error" in out else {"output": out})}
            for attempt in range(4):
                try:
                    self.studio.post(f"/api/painter/jobs/{job_id}/done", body)
                    break
                except StudioError as exc:
                    if exc.status in (400, 401, 403, 404, 409):
                        self.last_error = f"job {job_id}: {exc}"
                        break
                    time.sleep(2 * (attempt + 1))
                except requests.RequestException:
                    time.sleep(2 * (attempt + 1))
        finally:
            with self.lock:
                self.running.pop(job_id, None)

    # ---- forever ----

    def loop(self, stop: threading.Event | None = None) -> None:
        stop = stop or threading.Event()
        backoff = 5
        print(f"[painter] {self.name} ({self.id}) → {self.studio.url}", file=sys.stderr)
        while not stop.is_set():
            try:
                wait = self.tick() / 1000
                backoff = 5
                if self.last_error.startswith("studio:"):
                    self.last_error = ""
            except (StudioError, requests.RequestException, ValueError, KeyError) as exc:
                self.last_error = f"studio: {exc}"
                print(f"[painter] heartbeat failed: {exc}", file=sys.stderr)
                wait = backoff
                backoff = min(60, backoff * 2)
            stop.wait(max(1.0, wait))


def from_env(on_pod: bool = False) -> Painter:
    url = os.environ.get("STUDIO_URL", "").strip()
    token = (os.environ.get("PAINTER_TOKEN") or os.environ.get("STUDIO_WORKER_TOKEN") or "").strip()
    if not url or not token:
        raise SystemExit("STUDIO_URL and PAINTER_TOKEN are required")
    state = Path(os.environ.get("PAINTER_STATE_DIR") or (Path.home() / ".cinema-painter"))
    os.environ.setdefault("PAINTER_STATE_DIR", str(state))
    name = os.environ.get("PAINTER_NAME") or socket.gethostname().split(".")[0]
    explicit = f"gpu-pod-{os.environ['RUNPOD_POD_ID']}" if on_pod and os.environ.get("RUNPOD_POD_ID") else os.environ.get("PAINTER_ID")
    return Painter(Studio(url, token), painter_id(state, explicit), name, slots=int(os.environ.get("PAINTER_SLOTS", "2")), on_pod=on_pod)


def start_in_background(on_pod: bool = True) -> threading.Thread | None:
    """For server.py: the GPU pod draws too while it runs, unless PAINTER_ON_POD=0."""
    if os.environ.get("PAINTER_ON_POD", "1") == "0" or not os.environ.get("STUDIO_URL"):
        return None
    try:
        p = from_env(on_pod=on_pod)
    except SystemExit as exc:
        print(f"[painter] not started: {exc}", file=sys.stderr)
        return None
    t = threading.Thread(target=p.loop, name="painter", daemon=True)
    t.start()
    return t


def main() -> int:
    p = from_env()
    tempfile.tempdir = os.environ.get("PAINTER_TMP") or None
    p.loop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
