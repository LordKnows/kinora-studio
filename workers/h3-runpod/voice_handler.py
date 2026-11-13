"""Voice jobs on the pod: Qwen3-TTS VoiceDesign speaks one line several times, one take per seed.

The Studio sends a line, the voice it should be spoken in (a written description: the voice card's
state, with the line's delivery after it) and a few seeds; the takes go to R2 and the Studio's
webhook, where the user picks one. VoiceDesign builds the voice from the description every time,
so takes differ and one is chosen by ear; each take carries how close it is to the voice card's
reference audio, to flag one that drifted.

Job input (POST /voice, built by src/studio/voice-pod.ts):
    {"text": "...", "language": "Chinese", "instruct": "...", "seeds": [11, 12, 13, 14],
     "anchor_url": "https://.../reference.wav" | null,
     "output": {"prefix": "projects/p1/voice/vjb_1"}, "studio_voice_job_id": "vjb_1"}
Output:
    {"model": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", "takes": [{"seed", "url", "key", "duration_s",
     "similarity"}], "anchor": true, "load_ms": 0, "gen_ms": 9000}

The model runs in voice_worker.py, in its own virtualenv (voice_setup.sh), started on the first
job and stopped after VOICE_IDLE_S without one so its GPU memory goes back to the video models.
Voice jobs share the job server's one GPU queue (they go ahead of waiting renders, never beside a
running one); ComfyUI may still hold its models, so on an out-of-memory error ComfyUI is asked to
free its memory and the take is tried once more.
"""

from __future__ import annotations

import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

import handler as h3

HERE = Path(__file__).resolve().parent
MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
MODEL_SUBDIR = "tts/qwen3-tts-12hz-1.7b-voicedesign"
SPEAKER_FILE = ("tts/wespeaker", "voxceleb_resnet293_LM.onnx")
VOICE_LIST = "models-voice.txt"
VOICE_PYTHON = os.environ.get("VOICE_PYTHON", "/app/voice-venv/bin/python")
VOICE_STATE_DIR = Path(os.environ.get("VOICE_STATE_DIR", "/app/voice"))
VOICE_IDLE_S = float(os.environ.get("VOICE_IDLE_S", "600"))
VOICE_TIMEOUT_S = float(os.environ.get("VOICE_TIMEOUT_S", "600"))
LANGUAGES = ("Chinese", "English", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian")
MAX_TEXT = 400
MAX_INSTRUCT = 1000
MAX_TAKES = 8
PREFIX_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$")


def enabled() -> bool:
    return os.environ.get("VOICE_DESIGN", "1") == "1"


def models_dir() -> Path:
    return Path(os.environ.get("MODELS_DIR", str(h3.LORA_DIR.parent)))


def max_new_tokens(text: str) -> int:
    """The codec runs at 12.5 tokens a second; room for a slow, broken delivery (two seconds a character), capped."""
    return min(2000, 125 + 25 * len(text))


# ---------- input ----------


def validate_voice_input(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise h3.JobError("input must be an object")
    text = str(raw.get("text") or "").strip()
    if not text or len(text) > MAX_TEXT:
        raise h3.JobError(f"text must be 1–{MAX_TEXT} characters")
    instruct = str(raw.get("instruct") or "").strip()
    if not instruct or len(instruct) > MAX_INSTRUCT:
        raise h3.JobError(f"instruct (the voice description) must be 1–{MAX_INSTRUCT} characters")
    language = str(raw.get("language") or "Chinese")
    if language not in LANGUAGES:
        raise h3.JobError(f"language must be one of {', '.join(LANGUAGES)}")
    seeds = raw.get("seeds")
    if not isinstance(seeds, list) or not 1 <= len(seeds) <= MAX_TAKES or not all(isinstance(s, int) and not isinstance(s, bool) and 0 <= s < 2**31 for s in seeds):
        raise h3.JobError(f"seeds must be 1–{MAX_TAKES} integers in [0, 2^31)")
    if len(set(seeds)) != len(seeds):
        raise h3.JobError("seeds must differ: the same seed gives the same take")
    anchor = raw.get("anchor_url")
    if anchor is not None and not (isinstance(anchor, str) and anchor.startswith(("https://", "http://"))):
        raise h3.JobError("anchor_url must be an http(s) URL")
    prefix = str((raw.get("output") or {}).get("prefix") or "")
    if not PREFIX_RE.match(prefix) or ".." in prefix:
        raise h3.JobError("output.prefix must be a plain R2 key prefix")
    return {"text": text, "instruct": instruct, "language": language, "seeds": seeds, "anchor_url": anchor,
            "prefix": prefix.rstrip("/"), "studio_voice_job_id": raw.get("studio_voice_job_id")}


# ---------- the worker process ----------


class VoiceWorker:
    """The voice_worker.py process: started on demand, one request at a time, stopped when idle."""

    def __init__(self, cmd: list[str] | None = None, idle_s: float = VOICE_IDLE_S, log_path: str | None = None) -> None:
        self.cmd = cmd
        self.idle_s = idle_s
        self.log_path = log_path or os.environ.get("VOICE_LOG", "/app/voice_worker.log")
        self.proc: subprocess.Popen[str] | None = None
        self.lines: "queue.Queue[str | None]" = queue.Queue()
        self.lock = threading.Lock()
        self.last_used = 0.0
        if idle_s > 0:
            threading.Thread(target=self._idle_loop, name="voice-idle", daemon=True).start()

    def command(self) -> list[str]:
        if self.cmd:
            return self.cmd
        base = models_dir()
        return [VOICE_PYTHON, "-u", str(HERE / "voice_worker.py"), "--model", str(base / MODEL_SUBDIR),
                "--speaker", str(base / SPEAKER_FILE[0] / SPEAKER_FILE[1])]

    def loaded(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self) -> None:
        try:
            log = open(self.log_path, "a")  # noqa: SIM115 — lives as long as the process
        except OSError:
            log = subprocess.DEVNULL  # type: ignore[assignment]
        self.lines = queue.Queue()
        self.proc = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, text=True, bufsize=1)
        out = self.proc.stdout

        def read() -> None:
            for line in out:  # type: ignore[union-attr]
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=read, name="voice-reader", daemon=True).start()

    def request(self, payload: dict[str, Any], timeout: float = VOICE_TIMEOUT_S) -> dict[str, Any]:
        with self.lock:
            if not self.loaded():
                self._start()
            rid = uuid.uuid4().hex
            self.last_used = time.monotonic()
            try:
                self.proc.stdin.write(json.dumps({**payload, "id": rid}, ensure_ascii=False) + "\n")  # type: ignore[union-attr]
                self.proc.stdin.flush()  # type: ignore[union-attr]
            except (BrokenPipeError, OSError) as exc:
                self._stop()
                raise h3.JobError(f"the voice worker is not running ({exc}); see {self.log_path}") from exc
            deadline = time.monotonic() + timeout
            while True:
                left = deadline - time.monotonic()
                if left <= 0:
                    self._stop()
                    raise h3.JobError(f"the voice worker gave no answer in {int(timeout)} s and was stopped; see {self.log_path}")
                try:
                    line = self.lines.get(timeout=left)
                except queue.Empty:
                    continue
                if line is None:
                    code = self.proc.poll() if self.proc else None
                    self.proc = None
                    raise h3.JobError(f"the voice worker exited (code {code}); see {self.log_path}")
                try:
                    reply = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if reply.get("id") == rid:
                    self.last_used = time.monotonic()
                    return reply

    def _stop(self) -> None:
        proc, self.proc = self.proc, None
        if proc and proc.poll() is None:
            try:
                proc.stdin.close()  # type: ignore[union-attr]
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                proc.kill()

    def stop(self) -> None:
        with self.lock:
            self._stop()

    def stop_if_idle(self, now: float | None = None) -> bool:
        if not self.loaded() or not self.lock.acquire(blocking=False):
            return False
        try:
            if (now if now is not None else time.monotonic()) - self.last_used < self.idle_s:
                return False
            self._stop()
            print("[voice] worker stopped after an idle spell; its GPU memory is free", file=sys.stderr)
            return True
        finally:
            self.lock.release()

    def _idle_loop(self) -> None:
        while True:
            time.sleep(min(30.0, max(1.0, self.idle_s / 4)))
            self.stop_if_idle()


# ---------- status ----------


def voice_status(worker: VoiceWorker | None = None, base: Path | None = None) -> dict[str, Any]:
    """Whether the pod can take a voice job: the weights whole on the volume and the voice virtualenv installed."""
    base = base or models_dir()
    missing = [f"{sub}/{name}" for sub, name, size in h3.list_entries(HERE / VOICE_LIST) if not h3.file_ok(base, sub, name, size)]
    state_file = VOICE_STATE_DIR / "setup"
    setup = state_file.read_text().strip() if state_file.is_file() else "not started"
    on = enabled()
    ready = on and not missing and setup == "ready" and Path(VOICE_PYTHON).is_file()
    why = None if ready else ("VOICE_DESIGN=0 on this pod" if not on else
                              f"weights missing: {', '.join(m.split('/')[-1] for m in missing[:3])}{' …' if len(missing) > 3 else ''}" if missing else
                              f"the voice environment is {setup}" if setup != "ready" else f"no Python at {VOICE_PYTHON}")
    return {"ready": ready, "why": why, "model": MODEL_ID, "missing": missing, "setup": setup, "loaded": bool(worker and worker.loaded())}


# ---------- the job ----------


def prepare_anchor(url: str, workdir: Path) -> Path | None:
    """The reference audio as 16 kHz mono WAV, or None when it cannot be read (the takes are then unscored)."""
    try:
        ext = re.sub(r"[^a-z0-9]", "", h3.ext_of(url, "wav"))[:5] or "wav"
        src = h3.download(url, workdir / f"anchor-src.{ext}")
        dest = workdir / "anchor.wav"
        subprocess.run([h3.FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-ac", "1", "-ar", "16000", str(dest)], check=True, capture_output=True, timeout=120)
        return dest
    except Exception as exc:  # noqa: BLE001
        print(f"[voice] reference audio unreadable ({exc}); takes go unscored", file=sys.stderr)
        return None


def run_voice_job(params: dict[str, Any], worker: VoiceWorker, uploader: Any, workdir: Path, comfy: Any = None,
                  should_cancel: Callable[[], bool] | None = None, report: Callable[[dict[str, Any]], Any] | None = None) -> dict[str, Any]:
    anchor = prepare_anchor(params["anchor_url"], workdir) if params.get("anchor_url") else None
    takes: list[dict[str, Any]] = []
    load_ms = gen_ms = 0
    for i, seed in enumerate(params["seeds"]):
        if should_cancel and should_cancel():
            return {"error": "cancelled"}
        out = workdir / f"take-{i + 1}.wav"
        req = {"text": params["text"], "language": params["language"], "instruct": params["instruct"], "seed": seed,
               "out": str(out), "anchor": str(anchor) if anchor else None, "max_new_tokens": max_new_tokens(params["text"])}
        reply = worker.request(req)
        if not reply.get("ok") and reply.get("oom") and comfy is not None:
            print("[voice] out of GPU memory: asking ComfyUI to free its models, then once more", file=sys.stderr)
            try:
                comfy.free()
            except Exception as exc:  # noqa: BLE001
                print(f"[voice] ComfyUI /free failed: {exc}", file=sys.stderr)
            reply = worker.request(req)
        if not reply.get("ok"):
            raise h3.JobError(f"voice design failed on take {i + 1}: {reply.get('error')}")
        load_ms += int(reply.get("load_ms") or 0)
        gen_ms += int(reply.get("gen_ms") or 0)
        key = f"{params['prefix']}/take-{i + 1}-s{seed}.wav"
        url = uploader.upload(Path(reply.get("path") or out), key, "audio/wav")
        takes.append({"seed": seed, "url": url, "key": key, "duration_s": reply.get("duration_s"), "similarity": reply.get("similarity")})
        if report:
            report({"stage": "voice", "done": i + 1, "total": len(params["seeds"])})
    return {"model": MODEL_ID, "takes": takes, "anchor": anchor is not None, "load_ms": load_ms, "gen_ms": gen_ms}


def handler(event: dict[str, Any], worker: VoiceWorker, should_cancel: Callable[[], bool] | None = None,
            report: Callable[[dict[str, Any]], Any] | None = None, uploader: Any = None, comfy: Any = None) -> dict[str, Any]:
    """Job-server entry point. Returning {"error": ...} marks the job FAILED."""
    import tempfile

    try:
        params = validate_voice_input(event.get("input") or {})
        status = voice_status(worker)
        if not status["ready"]:
            raise h3.JobError(f"the pod cannot speak yet: {status['why']}")
        with tempfile.TemporaryDirectory(prefix="voice-") as tmp:
            return run_voice_job(params, worker, uploader or h3.R2Uploader(), Path(tmp), comfy or h3.ComfyClient(), should_cancel, report)
    except h3.JobError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # noqa: BLE001 — surface everything to the Studio
        return {"error": f"{type(exc).__name__}: {exc}"}
