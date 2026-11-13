"""Voice jobs on the pod: input checks, the worker process, the job (takes, uploads, the out-of-memory retry),
readiness, and voice jobs going ahead of waiting renders. A fake worker speaks the real protocol; no model, no GPU."""

import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

import handler as h3
import voice_handler as vh
from server import JobServer

FAKE_WORKER = textwrap.dedent('''
    import json, sys, wave, os
    flag = sys.argv[1]
    for line in sys.stdin:
        req = json.loads(line)
        if req.get("op") == "ping":
            print(json.dumps({"id": req["id"], "ok": True, "loaded": True}), flush=True); continue
        if req["text"] == "die":
            sys.exit(3)
        if req["text"] == "oom once" and not os.path.exists(flag):
            open(flag, "w").close()
            print(json.dumps({"id": req["id"], "ok": False, "error": "CUDA out of memory", "oom": True}), flush=True); continue
        print("a stray library line on stdout that is not JSON", flush=True)
        with wave.open(req["out"], "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(b"\\x00\\x00" * 2400)
        print(json.dumps({"id": req["id"], "ok": True, "path": req["out"], "duration_s": 0.1, "sample_rate": 24000,
                          "similarity": 0.7 if req.get("anchor") else None, "load_ms": 5, "gen_ms": 7}), flush=True)
''')


@pytest.fixture
def worker(tmp_path):
    script = tmp_path / "fake_worker.py"
    script.write_text(FAKE_WORKER)
    w = vh.VoiceWorker(cmd=[sys.executable, "-u", str(script), str(tmp_path / "oom.flag")], idle_s=0, log_path=str(tmp_path / "worker.log"))
    yield w
    w.stop()


class Uploader:
    def __init__(self):
        self.calls = []

    def upload(self, path, key, content_type):
        assert Path(path).is_file()
        self.calls.append((key, content_type))
        return f"https://media.example/{key}"


class Comfy:
    def __init__(self):
        self.freed = 0

    def free(self):
        self.freed += 1


def job(**over):
    base = {"text": "今晚的雨下得真大。", "instruct": "a young woman, mezzo voice. Emotion: angry", "language": "Chinese",
            "seeds": [11, 12], "output": {"prefix": "projects/p1/voice/vjb_1"}, "studio_voice_job_id": "vjb_1"}
    return {**base, **over}


def test_input_is_checked():
    p = vh.validate_voice_input(job())
    assert p["seeds"] == [11, 12] and p["prefix"] == "projects/p1/voice/vjb_1" and p["anchor_url"] is None
    for bad in [job(text=""), job(text="很" * 401), job(instruct=""), job(language="Klingon"), job(seeds=[]), job(seeds=[1] * 9),
                job(seeds=[5, 5]), job(seeds=[True]), job(seeds=[-1]), job(output={"prefix": "../etc"}), job(output={"prefix": "a/../b"}),
                job(anchor_url="file:///etc/passwd")]:
        with pytest.raises(h3.JobError):
            vh.validate_voice_input(bad)


def test_a_job_speaks_one_take_per_seed_and_uploads_each(worker, tmp_path):
    up, reports = Uploader(), []
    out = vh.run_voice_job(vh.validate_voice_input(job()), worker, up, tmp_path, Comfy(), report=reports.append)
    assert [t["seed"] for t in out["takes"]] == [11, 12]
    assert up.calls == [("projects/p1/voice/vjb_1/take-1-s11.wav", "audio/wav"), ("projects/p1/voice/vjb_1/take-2-s12.wav", "audio/wav")]
    assert out["takes"][0]["url"] == "https://media.example/projects/p1/voice/vjb_1/take-1-s11.wav"
    assert out["takes"][0]["similarity"] is None and out["anchor"] is False
    assert out["model"] == vh.MODEL_ID and out["gen_ms"] == 14
    assert reports[-1] == {"stage": "voice", "done": 2, "total": 2}
    assert worker.loaded()


def test_takes_are_scored_against_the_reference_when_it_reads(worker, tmp_path, monkeypatch):
    monkeypatch.setattr(vh, "prepare_anchor", lambda url, wd: wd / "anchor.wav")
    out = vh.run_voice_job(vh.validate_voice_input(job(anchor_url="https://media.example/u/ref.wav")), worker, Uploader(), tmp_path)
    assert out["anchor"] is True and {t["similarity"] for t in out["takes"]} == {0.7}


def test_out_of_memory_frees_comfy_and_tries_once_more(worker, tmp_path):
    comfy = Comfy()
    out = vh.run_voice_job(vh.validate_voice_input(job(text="oom once", seeds=[3])), worker, Uploader(), tmp_path, comfy)
    assert comfy.freed == 1 and len(out["takes"]) == 1


def test_a_worker_that_dies_fails_the_job_with_its_log_and_restarts_next_time(worker, tmp_path):
    with pytest.raises(h3.JobError, match="exited"):
        vh.run_voice_job(vh.validate_voice_input(job(text="die")), worker, Uploader(), tmp_path)
    assert not worker.loaded()
    assert len(vh.run_voice_job(vh.validate_voice_input(job(seeds=[1])), worker, Uploader(), tmp_path)["takes"]) == 1


def test_cancel_between_takes(worker, tmp_path):
    out = vh.run_voice_job(vh.validate_voice_input(job()), worker, Uploader(), tmp_path, should_cancel=lambda: True)
    assert out == {"error": "cancelled"}


def test_an_idle_worker_is_stopped(worker, tmp_path):
    worker.idle_s = 60
    vh.run_voice_job(vh.validate_voice_input(job(seeds=[1])), worker, Uploader(), tmp_path)
    assert not worker.stop_if_idle(now=worker.last_used + 10) and worker.loaded()
    assert worker.stop_if_idle(now=worker.last_used + 61) and not worker.loaded()


def test_ready_only_with_the_weights_whole_and_the_environment_built(tmp_path, monkeypatch):
    models, state, py = tmp_path / "models", tmp_path / "state", tmp_path / "python"
    monkeypatch.setattr(vh, "VOICE_STATE_DIR", state)
    monkeypatch.setattr(vh, "VOICE_PYTHON", str(py))
    s = vh.voice_status(base=models)
    assert not s["ready"] and "weights missing" in s["why"] and len(s["missing"]) == 12
    for sub, name, size in h3.list_entries(vh.HERE / vh.VOICE_LIST):
        (models / sub).mkdir(parents=True, exist_ok=True)
        with open(models / sub / name, "wb") as fh:
            fh.truncate(size)  # sparse: the size is what counts
    assert vh.voice_status(base=models)["why"] == "the voice environment is not started"
    state.mkdir()
    (state / "setup").write_text("installing\n")
    assert vh.voice_status(base=models)["why"] == "the voice environment is installing"
    (state / "setup").write_text("ready\n")
    py.write_text("")
    assert vh.voice_status(base=models)["ready"] is True
    monkeypatch.setenv("VOICE_DESIGN", "0")
    assert vh.voice_status(base=models)["why"] == "VOICE_DESIGN=0 on this pod"


def test_the_job_refuses_while_the_pod_cannot_speak(worker, monkeypatch):
    monkeypatch.setattr(vh, "voice_status", lambda w=None, base=None: {"ready": False, "why": "the voice environment is installing"})
    assert vh.handler({"input": job()}, worker) == {"error": "the pod cannot speak yet: the voice environment is installing"}


def test_voice_jobs_go_ahead_of_waiting_renders_never_beside_the_running_one():
    gate, order = threading.Event(), []

    def video(inp):
        order.append(inp["name"])
        if inp["name"] == "render-1":
            gate.wait(5)
        return {}

    server = JobServer(video, lambda inp: {}, token="t0k", post=lambda *a, **k: None, run_voice=lambda inp: order.append(inp["name"]) or {"takes": []})
    first = server.enqueue("video", {"input": {"name": "render-1"}})
    deadline = time.time() + 5
    while server.store.get(first["id"])["status"] != "IN_PROGRESS" and time.time() < deadline:
        time.sleep(0.01)
    server.enqueue("video", {"input": {"name": "render-2"}})
    voice = server.enqueue("voice", {"input": {"name": "line"}})
    time.sleep(0.05)
    assert order == ["render-1"]  # the running render is not joined by the voice job
    gate.set()
    while server.store.get(voice["id"])["status"] != "COMPLETED" and time.time() < deadline:
        time.sleep(0.01)
    time.sleep(0.05)
    assert order == ["render-1", "line", "render-2"]


def test_without_a_voice_runner_there_is_no_voice_route():
    server = JobServer(lambda inp: {}, lambda inp: {}, token="t0k", post=lambda *a, **k: None)
    assert "voice" not in server.runners
