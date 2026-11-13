"""Voice design worker: Qwen3-TTS VoiceDesign on the pod's GPU, one process, JSON lines on stdin/stdout.

It runs in its own virtualenv (voice_setup.sh): qwen-tts pins its own transformers and accelerate,
which must not reach ComfyUI. voice_handler.py starts it on the first voice job and stops it when
it has been idle a while, so its GPU memory goes back to the video models.

One request, one take:
    {"id": "...", "text": "...", "language": "Chinese", "instruct": "...", "seed": 11,
     "out": "/tmp/.../take-1.wav", "anchor": "/tmp/.../anchor.wav" | null, "max_new_tokens": 300}
    → {"id": "...", "ok": true, "path": "...", "duration_s": 2.6, "sample_rate": 24000,
       "similarity": 0.71 | null, "load_ms": 0, "gen_ms": 2100}
    → {"id": "...", "ok": false, "error": "...", "oom": true | false}
{"id": "...", "op": "ping"} answers {"id": "...", "ok": true, "loaded": false}.

similarity is the cosine of WeSpeaker ResNet293-LM speaker embeddings (16 kHz mono, whole clip)
between the take and the anchor: the voice card's reference audio. It only flags a take that has
drifted far from the voice; it does not pick the best one.

Run with: <voice venv>/bin/python -u voice_worker.py --model <dir> --speaker <onnx>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from typing import Any

# The replies go to the original stdout; anything a library prints lands in the log (stderr) instead.
_PROTO = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402

SPEAKER_SR = 16000


def log(msg: str) -> None:
    print(f"[voice-worker] {msg}", file=sys.stderr, flush=True)


def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed % (2**32))
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def load_mono(path: str, sr: int) -> np.ndarray:
    import torchaudio.functional as AF

    wav, got = sf.read(path, dtype="float32", always_2d=False)
    if wav.ndim > 1:
        wav = wav.mean(axis=1)
    t = torch.from_numpy(np.ascontiguousarray(wav))
    if got != sr:
        t = AF.resample(t, got, sr)
    return t.numpy()


class Speaker:
    """WeSpeaker ResNet293-LM (ONNX, CPU): 80-dim Kaldi fbank, mean-normalised, as wespeaker extracts it."""

    def __init__(self, onnx_path: str) -> None:
        self.path = onnx_path
        self._sess = None
        self._cache: dict[tuple[str, float], np.ndarray] = {}

    def _session(self):
        if self._sess is None:
            import onnxruntime as ort

            so = ort.SessionOptions()
            so.intra_op_num_threads = 4
            self._sess = ort.InferenceSession(self.path, so, providers=["CPUExecutionProvider"])
        return self._sess

    def embed(self, path: str) -> np.ndarray:
        key = (path, os.path.getmtime(path))
        if key in self._cache:
            return self._cache[key]
        import torchaudio.compliance.kaldi as kaldi

        wav = torch.from_numpy(load_mono(path, SPEAKER_SR)).unsqueeze(0) * (1 << 15)
        feats = kaldi.fbank(wav, num_mel_bins=80, frame_length=25, frame_shift=10, dither=0.0,
                            sample_frequency=SPEAKER_SR, window_type="hamming")
        feats = feats - feats.mean(dim=0, keepdim=True)
        e = self._session().run(None, {"feats": feats.unsqueeze(0).numpy().astype(np.float32)})[0][0]
        e = e / (np.linalg.norm(e) or 1.0)
        self._cache[key] = e
        return e

    def similarity(self, a: str, b: str) -> float:
        return round(float(np.dot(self.embed(a), self.embed(b))), 4)


class Engine:
    def __init__(self, model_dir: str) -> None:
        self.model_dir = model_dir
        self.model = None

    def load(self) -> int:
        if self.model is not None:
            return 0
        from qwen_tts import Qwen3TTSModel

        t = time.monotonic()
        cuda = torch.cuda.is_available()
        kwargs: dict[str, Any] = {"device_map": "cuda:0" if cuda else "cpu", "dtype": torch.bfloat16 if cuda else torch.float32}
        try:
            import flash_attn  # noqa: F401

            kwargs["attn_implementation"] = "flash_attention_2"
        except ImportError:
            pass
        self.model = Qwen3TTSModel.from_pretrained(self.model_dir, **kwargs)
        ms = int((time.monotonic() - t) * 1000)
        log(f"model loaded in {ms} ms on {kwargs['device_map']} ({kwargs.get('attn_implementation', 'default attention')})")
        return ms

    def speak(self, text: str, language: str, instruct: str, seed: int, max_new_tokens: int) -> tuple[np.ndarray, int]:
        set_seed(seed)
        wavs, sr = self.model.generate_voice_design(text=text, language=language, instruct=instruct, max_new_tokens=max_new_tokens)
        return np.asarray(wavs[0], dtype=np.float32), int(sr)


def is_oom(exc: BaseException) -> bool:
    return isinstance(exc, getattr(torch.cuda, "OutOfMemoryError", ())) or "out of memory" in str(exc).lower()


def handle(req: dict[str, Any], engine: Engine, speaker: Speaker) -> dict[str, Any]:
    rid = req.get("id")
    if req.get("op") == "ping":
        return {"id": rid, "ok": True, "loaded": engine.model is not None}
    try:
        load_ms = engine.load()
        t = time.monotonic()
        wav, sr = engine.speak(str(req["text"]), str(req.get("language") or "Chinese"), str(req["instruct"]), int(req["seed"]), int(req.get("max_new_tokens") or 600))
        gen_ms = int((time.monotonic() - t) * 1000)
        if not len(wav):
            return {"id": rid, "ok": False, "error": "the model returned no audio", "oom": False}
        sf.write(req["out"], wav, sr, subtype="PCM_16")
        similarity = None
        if req.get("anchor"):
            try:
                similarity = speaker.similarity(req["out"], req["anchor"])
            except Exception as exc:  # noqa: BLE001 — a take without a score is still a take
                log(f"similarity failed: {type(exc).__name__}: {exc}")
        return {"id": rid, "ok": True, "path": req["out"], "duration_s": round(len(wav) / sr, 3), "sample_rate": sr,
                "similarity": similarity, "load_ms": load_ms, "gen_ms": gen_ms}
    except Exception as exc:  # noqa: BLE001 — every failure goes back to the job
        oom = is_oom(exc)
        if oom and torch.cuda.is_available():
            torch.cuda.empty_cache()
        return {"id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"[:800], "oom": oom}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--speaker", required=True)
    args = ap.parse_args()
    engine, speaker = Engine(args.model), Speaker(args.speaker)
    log(f"ready (cuda: {torch.cuda.is_available()})")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _PROTO.write(json.dumps({"ok": False, "error": f"bad request: {exc}"}) + "\n")
            continue
        _PROTO.write(json.dumps(handle(req, engine, speaker), ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
