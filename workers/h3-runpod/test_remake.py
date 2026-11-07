"""The Viggle Remake input and graph on the pod."""

from __future__ import annotations

import sys

import pytest

h3 = sys.modules["handler_h3_runpod"]


def test_remake_input_and_graph():
    with pytest.raises(h3.JobError, match="17n"):
        h3.validate_remake_input({"workflow": "REMAKE", "video": "https://x/v.mp4", "prompt": "retention_analysis:", "refs": ["https://x/a.png"], "frames": 100, "output": {"key": "a.mp4"}})
    with pytest.raises(h3.JobError, match="one source frame index per ref"):
        h3.validate_remake_input({"workflow": "REMAKE", "video": "https://x/v.mp4", "prompt": "retention_analysis:", "refs": ["https://x/a.png"], "pins": [1, 2], "output": {"key": "a.mp4"}})
    params = h3.validate_remake_input({"workflow": "REMAKE", "mode": "swap", "video": "https://x/v.mp4", "prompt": "subject_definitions:\nretention_analysis:\n", "refs": ["https://x/a.png", "https://x/b.png"], "pins": [12, 100], "frames": 124, "output": {"key": "a.mp4"}})
    mapping = h3.load_mapping()["REMAKE"]
    graph = h3.fill_remake_graph(h3.load_workflow("REMAKE"), mapping, {**params, "files": {"video": "src.mp4", "refs": ["a.png", "b.png"]}})
    assert graph["1"]["inputs"]["unet_name"] == "viggle_remake_swap_pruned_int8_convrot.safetensors"
    assert graph["15"]["inputs"]["sigmas"].startswith("1.0, 0.990476")
    assert graph["11"]["inputs"]["pins"] == "12, 100" and graph["11"]["inputs"]["frames"] == 124
    assert "ref_3" not in graph["11"]["inputs"] and "21" not in graph and "22" not in graph
    assert graph["9"]["inputs"]["image"] == "a.png" and graph["10"]["inputs"]["image"] == "b.png"
    # every link points at a node that is still there
    for nid, node in graph.items():
        for v in node["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                assert v[0] in graph, (nid, v)


def test_remake_status_reads_files(tmp_path, monkeypatch):
    (tmp_path / "diffusion_models").mkdir()
    (tmp_path / "diffusion_models" / "viggle_remake_edit_pruned_int8_convrot.safetensors").write_bytes(b"0" * 2_000_000)
    nodes = tmp_path / "nodes"
    nodes.mkdir()
    (nodes / "nodes.py").write_text("#")
    monkeypatch.setattr(h3, "REMAKE_NODE_DIR", str(nodes))
    st = h3.remake_status(tmp_path)
    assert st["ready"] and st["modes"] == {"edit": True, "swap": False}
