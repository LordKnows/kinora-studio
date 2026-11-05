"""Job server for Pod mode.

Runs inside the studio's RunPod pod next to ComfyUI and speaks the same job
shape as RunPod Serverless, so the Studio's PodBackend can treat both alike:

    GET  /health            → {ok, comfy, workflows}
    POST /run               {input, webhook?}  → {id, status: IN_QUEUE}
    POST /assemble          {input, webhook?}  → {id, status: IN_QUEUE}
    GET  /status/<id>       → {id, status, output?, error?, executionTime?}
    POST /cancel/<id>       → {id, status}

Every request must carry `X-Studio-Token`; the RunPod HTTP proxy is public.
Jobs run one at a time on a worker thread (one GPU). When a job finishes and
a webhook was given, the job object is POSTed there (3 attempts).
"""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import uuid
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

import requests

# A runner takes the job input and a should_cancel() probe it may poll.
Runner = Callable[..., dict[str, Any]]

MAX_JOBS_KEPT = 200


class JobStore:
    """Thread-safe bounded map of job id → job object."""

    def __init__(self) -> None:
        self._jobs: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
        self._lock = threading.Lock()

    def put(self, job: dict[str, Any]) -> None:
        with self._lock:
            self._jobs[job["id"]] = job
            while len(self._jobs) > MAX_JOBS_KEPT:
                self._jobs.popitem(last=False)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id: str, **fields: Any) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            job.update(fields)
            return dict(job)


class JobServer:
    def __init__(self, run_video: Runner, run_assemble: Runner, token: str, health: Callable[[], dict[str, Any]] | None = None, post: Callable[..., Any] | None = None, interrupt: Callable[[], Any] | None = None) -> None:
        self.runners = {"video": run_video, "assemble": run_assemble}
        self.token = token
        self.health = health or (lambda: {"ok": True})
        # Called when a running job is cancelled: tells ComfyUI to stop sampling.
        self.interrupt = interrupt or (lambda: None)
        self.post = post or requests.post
        self.store = JobStore()
        self.queue: "queue.Queue[str]" = queue.Queue()
        self.cancelled: set[str] = set()
        self._worker = threading.Thread(target=self._loop, name="jobs", daemon=True)
        self._worker.start()

    # ---- jobs ----

    def enqueue(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        job = {
            "id": uuid.uuid4().hex,
            "kind": kind,
            "status": "IN_QUEUE",
            "input": payload.get("input") or {},
            "webhook": payload.get("webhook"),
            "queued_at": time.time(),
        }
        self.store.put(job)
        self.queue.put(job["id"])
        return self.public(job)

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        job = self.store.get(job_id)
        if job is None:
            return None
        if job["status"] == "IN_QUEUE":
            self.cancelled.add(job_id)
            return self.public(self.store.update(job_id, status="CANCELLED") or job)
        if job["status"] == "IN_PROGRESS":
            # The runner polls should_cancel(); ComfyUI is interrupted right away
            # so the GPU stops now rather than at the end of the sampling loop.
            self.cancelled.add(job_id)
            try:
                self.interrupt()
            except Exception as exc:  # noqa: BLE001 — the job still ends as cancelled
                print(f"[jobs] interrupt failed: {exc}", file=sys.stderr)
            return {**self.public(job), "cancelRequested": True}
        return self.public(job)

    def _loop(self) -> None:
        while True:
            job_id = self.queue.get()
            if job_id in self.cancelled:
                continue
            job = self.store.get(job_id)
            if job is None:
                continue
            self.store.update(job_id, status="IN_PROGRESS", started_at=time.time())
            started = time.monotonic()
            should_cancel = lambda jid=job_id: jid in self.cancelled  # noqa: E731
            runner = self.runners[job["kind"]]
            try:
                try:
                    output = runner(job["input"], should_cancel)
                except TypeError as exc:
                    if "positional argument" not in str(exc):
                        raise
                    output = runner(job["input"])  # a runner that does not poll for cancellation
            except Exception as exc:  # noqa: BLE001 — anything else is a FAILED job
                output = {"error": f"{type(exc).__name__}: {exc}"}
            elapsed = int((time.monotonic() - started) * 1000)
            if job_id in self.cancelled:
                done = self.store.update(job_id, status="CANCELLED", executionTime=elapsed)
            elif isinstance(output, dict) and "error" in output:
                done = self.store.update(job_id, status="FAILED", error=output["error"], executionTime=elapsed)
            else:
                done = self.store.update(job_id, status="COMPLETED", output=output, executionTime=elapsed)
            if done and done.get("webhook"):
                self._notify(done)

    def _notify(self, job: dict[str, Any]) -> None:
        body = self.public(job)
        for attempt in range(3):
            try:
                res = self.post(job["webhook"], json=body, timeout=20)
                if getattr(res, "status_code", 200) < 400:
                    return
            except Exception:  # noqa: BLE001
                pass
            time.sleep(2 * (attempt + 1))

    @staticmethod
    def public(job: dict[str, Any]) -> dict[str, Any]:
        out = {"id": job["id"], "status": job["status"]}
        for key in ("output", "error", "executionTime"):
            if key in job:
                out[key] = job[key]
        return out

    # ---- http ----

    def handler_class(self) -> type[BaseHTTPRequestHandler]:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, status: int, payload: dict[str, Any]) -> None:
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _authed(self) -> bool:
                if self.headers.get("X-Studio-Token") == server.token:
                    return True
                self._send(401, {"error": "bad token"})
                return False

            def _body(self) -> dict[str, Any]:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    data = json.loads(raw or b"{}")
                except json.JSONDecodeError:
                    return {}
                return data if isinstance(data, dict) else {}

            def do_GET(self) -> None:  # noqa: N802
                if not self._authed():
                    return
                if self.path == "/health":
                    self._send(200, server.health())
                elif self.path.startswith("/status/"):
                    job = server.store.get(self.path[len("/status/"):])
                    self._send(200, server.public(job)) if job else self._send(404, {"error": "unknown job"})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self) -> None:  # noqa: N802
                if not self._authed():
                    return
                if self.path == "/run":
                    self._send(200, server.enqueue("video", self._body()))
                elif self.path == "/assemble":
                    self._send(200, server.enqueue("assemble", self._body()))
                elif self.path.startswith("/cancel/"):
                    job = server.cancel(self.path[len("/cancel/"):])
                    self._send(200, job) if job else self._send(404, {"error": "unknown job"})
                else:
                    self._send(404, {"error": "not found"})

            def log_message(self, fmt: str, *args: Any) -> None:
                sys.stderr.write("[jobs] " + fmt % args + "\n")

        return Handler

    def serve(self, host: str, port: int) -> ThreadingHTTPServer:
        httpd = ThreadingHTTPServer((host, port), self.handler_class())
        return httpd


def main() -> int:
    import handler as h3
    import assembler_handler as asm

    token = os.environ.get("STUDIO_WORKER_TOKEN")
    if not token:
        print("STUDIO_WORKER_TOKEN is required", file=sys.stderr)
        return 2
    comfy = h3.ComfyClient()
    server = JobServer(
        run_video=lambda inp, should_cancel=None: h3.handler({"input": inp}, should_cancel),
        run_assemble=lambda inp, should_cancel=None: asm.handler({"input": inp}),
        token=token,
        health=lambda: h3.health(comfy),
        interrupt=comfy.interrupt,
    )
    port = int(os.environ.get("STUDIO_PORT", "8000"))
    httpd = server.serve("0.0.0.0", port)
    print(f"[jobs] listening on :{port}", file=sys.stderr)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
