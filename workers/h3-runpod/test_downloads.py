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
                assert url.startswith("https://huggingface.co/") and size.isdigit() and int(size) > 1_000_000, (listing.name, line)
