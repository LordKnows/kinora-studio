"""download_models.sh, run at every boot: keeps files of the right size,
fetches missing ones, fetches a wrong-size one again (resuming a short one),
and goes on past a file that fails — it is recorded, the rest still come down."""

from __future__ import annotations

import http.server
import os
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
FILES = {"a.safetensors": b"A" * 300_000, "b.safetensors": b"B" * 200_000, "c.safetensors": b"C" * 100_000}


class RangeHandler(http.server.BaseHTTPRequestHandler):
    """Serves FILES, with Range (resume) and a 404 for anything else."""

    hits: list[str] = []

    def log_message(self, *a):  # quiet
        pass

    def do_GET(self):  # noqa: N802
        name = self.path.rsplit("/", 1)[-1]
        RangeHandler.hits.append(name)
        body = FILES.get(name)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        start = 0
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            start = int(rng[6:].split("-")[0] or 0)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{len(body) - 1}/{len(body)}")
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(len(body) - start))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self.wfile.write(body[start:])


@pytest.fixture
def server():
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RangeHandler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    RangeHandler.hits = []
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def run(listing: Path, models: Path, state: Path) -> subprocess.CompletedProcess:
    # curl only (the pod has aria2; here the fallback path is exercised), quick retries
    bin_dir = state.parent / "bin"
    bin_dir.mkdir(exist_ok=True)
    for tool in ("bash", "curl", "stat", "date", "basename", "dirname", "mkdir", "mv", "rm", "tr", "seq", "sleep", "cat", "ln", "mktemp"):
        path = shutil.which(tool)
        if path and not (bin_dir / tool).exists():
            (bin_dir / tool).symlink_to(path)
    env = {"PATH": str(bin_dir), "DOWNLOAD_STATE_DIR": str(state), "DOWNLOAD_TRIES": "2"}
    script = (HERE / "download_models.sh").read_text().replace("sleep $((attempt * 10))", "sleep 0")
    (state.parent / "dl.sh").write_text(script)
    return subprocess.run(["bash", str(state.parent / "dl.sh"), str(models), str(listing)], env=env, capture_output=True, text=True, timeout=60)


def test_keeps_right_sizes_fetches_the_rest_and_goes_on_past_a_failure(tmp_path, server):
    models, state = tmp_path / "models", tmp_path / "state"
    (models / "vae").mkdir(parents=True)
    (models / "vae" / "a.safetensors").write_bytes(FILES["a.safetensors"])  # complete: kept
    (models / "vae" / "b.safetensors").write_bytes(b"B" * 50_000)  # short: resumed
    (models / "vae" / "c.safetensors").write_bytes(b"X" * 150_000)  # too long: fetched again
    listing = tmp_path / "models.txt"
    listing.write_text(
        "# subdir<TAB>URL<TAB>bytes\n"
        f"vae\t{server}/f/a.safetensors\t300000\n"
        f"vae\t{server}/f/missing.safetensors\t1000\n"
        f"vae\t{server}/f/b.safetensors\t200000\n"
        f"vae\t{server}/f/c.safetensors\t100000\n"
    )
    r = run(listing, models, state)
    assert r.returncode == 1, r.stdout + r.stderr
    assert "have " in r.stdout and "FAILED missing.safetensors" in r.stdout
    for name in ("a.safetensors", "b.safetensors", "c.safetensors"):
        assert (models / "vae" / name).read_bytes() == FILES[name], name
    assert "a.safetensors" not in RangeHandler.hits  # nothing fetched for a complete file
    assert (state / "failed").read_text().strip() == "models.txt missing.safetensors"
    assert not (state / "current").exists()
    # the next boot: everything there but the broken one, nothing fetched again
    RangeHandler.hits = []
    os.remove(state / "failed")
    r = run(listing, models, state)
    assert RangeHandler.hits == ["missing.safetensors", "missing.safetensors"]


def test_every_list_names_sizes():
    for listing in sorted(HERE.glob("models*.txt")):
        for line in listing.read_text().splitlines():
            if line.strip() and not line.startswith("#"):
                subdir, url, size = line.split("\t")
                # weights are big; a transformers model also needs its small config and tokenizer files, listed by exact size
                small_ok = url.rsplit("/", 1)[-1].endswith((".json", ".txt"))
                assert url.startswith("https://huggingface.co/") and size.isdigit() and int(size) > (0 if small_ok else 1_000_000), (listing.name, line)


# ---------- models the Studio no longer runs: removed from the volume at boot ----------


def remove_retired(models: Path, listing: Path | None = None) -> subprocess.CompletedProcess:
    args = ["bash", str(HERE / "remove_retired_models.sh"), str(models)] + ([str(listing)] if listing else [])
    return subprocess.run(args, capture_output=True, text=True, timeout=60)


def test_retired_weights_are_removed_and_everything_else_stays(tmp_path):
    models = tmp_path / "models"
    retired = [line.split("\t") for line in (HERE / "retired-models.txt").read_text().splitlines() if line.strip() and not line.startswith("#")]
    assert len(retired) == 9
    for subdir, name in retired:
        (models / subdir).mkdir(parents=True, exist_ok=True)
        (models / subdir / name).write_bytes(b"x" * 2_000_000)
    # what a cut-off download left, and the same file under ComfyUI's other name for the folder
    (models / "vae" / "qwen_image_vae.safetensors.part").write_bytes(b"x" * 1000)
    (models / "vae" / "qwen_image_vae.safetensors.part.aria2").write_bytes(b"x")
    (models / "unet").mkdir()
    (models / "unet" / "qwen_image_2.1_int8_convrot.safetensors").write_bytes(b"x" * 1000)
    # the models the pod still runs, a user's own LoRA, and the H3 text encoder (a Qwen3-VL the H3 models load)
    kept = []
    for listing in sorted(HERE.glob("models*.txt")):
        for line in listing.read_text().splitlines():
            if line.strip() and not line.startswith("#"):
                subdir, url = line.split("\t")[:2]
                kept.append(models / subdir / url.rsplit("/", 1)[-1])
    kept.append(models / "loras" / "my_own_qwen_lora.safetensors")
    for path in kept:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"k")
    assert models / "text_encoders" / "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors" in kept
    r = remove_retired(models)
    assert r.returncode == 0, r.stdout + r.stderr
    assert not [p for p in models.rglob("*") if p.is_file() and p not in kept]
    assert all(p.is_file() for p in kept)
    assert r.stdout.strip().splitlines()[-1] == "retired models: 12 files removed, 17 MB freed"
    # the next boot finds nothing to do
    again = remove_retired(models)
    assert again.returncode == 0 and again.stdout.strip() == "retired models: 0 files removed, 0 MB freed"


def test_a_retired_list_never_takes_a_file_the_pod_still_downloads_or_one_outside_the_models(tmp_path):
    models = tmp_path / "models"
    (models / "vae").mkdir(parents=True)
    (models / "vae" / "minimax_h3_video_vae_fp16.safetensors").write_bytes(b"k")
    (tmp_path / "outside.safetensors").write_bytes(b"k")
    listing = tmp_path / "retired.txt"
    listing.write_text("# subdir<TAB>file\nvae\tminimax_h3_video_vae_fp16.safetensors\nvae\t../../outside.safetensors\n../..\toutside.safetensors\n")
    r = remove_retired(models, listing)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "keeping vae/minimax_h3_video_vae_fp16.safetensors" in r.stdout and r.stdout.count("skipping") == 2
    assert (models / "vae" / "minimax_h3_video_vae_fp16.safetensors").is_file() and (tmp_path / "outside.safetensors").is_file()


def test_no_list_names_a_retired_file_and_the_start_script_runs_the_cleanup():
    retired = {line.split("\t")[1] for line in (HERE / "retired-models.txt").read_text().splitlines() if line.strip() and not line.startswith("#")}
    for listing in sorted(HERE.glob("models*.txt")):
        assert not [n for n in retired if n in listing.read_text()], listing.name
    for graph in sorted((HERE / "workflows").glob("*.json")):
        assert not [n for n in retired if n in graph.read_text()], graph.name
    start = (HERE / "start.sh").read_text()
    assert start.index("remove_retired_models.sh") < start.index("fetch_list \"$dir\" models.txt")
