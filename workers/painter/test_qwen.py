"""Qwen-Image 3.0 Pro through an API (paint.py run_qwen): the pose gallery's
阿里云百炼 call, reached through TokenSail (OpenAI-style images endpoint) or
DashScope directly. The references go up as public URLs (re-hosted in R2 for
the job), the picture comes back as a short-lived URL and is fetched at once;
errors say what to do."""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import paint  # noqa: E402


def png(color=(10, 120, 200), size=(600, 900)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


class Res:
    def __init__(self, status=200, payload=None, content=b"", headers=None):
        self.status_code, self._payload, self.content = status, payload, content
        self.ok = status < 400
        self.text = json.dumps(payload) if payload is not None else ""
        self.headers = headers or {}

    def json(self):
        return self._payload

    def iter_content(self, n):
        yield self.content

    def raise_for_status(self):
        if not self.ok:
            raise AssertionError(self.status_code)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeVendor:
    """TokenSail or DashScope: answers the queued responses in turn, serves the hosted picture and the references."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.posts = []
        self.gets = []

    def post(self, url, headers=None, json=None, timeout=0):
        self.posts.append((url, headers, json))
        return self.answers.pop(0)

    def get(self, url, stream=False, timeout=0, **kw):
        self.gets.append(url)
        return Res(content=png((200, 30, 30), (1024, 1536)))


OK_TOKENSAIL = Res(payload={"created": 1, "data": [{"url": "https://assets.tokensail.ai/a/x.png"}]}, headers={"X-TokenSail-Cost": "0.0712"})
OK_DASHSCOPE = Res(payload={"output": {"choices": [{"message": {"content": [{"image": "https://dashscope-result.oss/x.png"}]}}]}})


@pytest.fixture
def tokensail(monkeypatch):
    monkeypatch.setenv("TOKENSAIL_API_KEY", "sk-tokensail-0000test")
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.delenv("QWEN_API_BASE", raising=False)
    monkeypatch.setattr(paint.time, "sleep", lambda s: None)


def test_tokensail_sends_the_references_as_urls_and_fetches_the_picture_at_once(tokensail):
    vendor = FakeVendor([OK_TOKENSAIL])
    refs = ["https://studio.test/media/projects/p/images/j1.ref0.jpg", "https://studio.test/media/projects/p/images/j1.ref1.jpg"]
    img, meta = paint.run_qwen("图1的人物穿上图2的服装", refs, 1024, 1536, {"api_model": "qwen-image-3.0-pro", "prompt_extend": False}, vendor, request_id="j1.r0")
    url, headers, body = vendor.posts[0]
    assert url == "https://api.tokensail.ai/v1/images/generations"
    assert headers["Authorization"] == "Bearer sk-tokensail-0000test" and headers["X-TokenSail-Request-Id"] == "j1.r0"
    assert body == {"model": "qwen-image-3.0-pro", "prompt": "图1的人物穿上图2的服装", "n": 1, "size": "1024x1536", "response_format": "url",
                    "image": refs, "prompt_extend": False, "watermark": False}
    assert vendor.gets == ["https://assets.tokensail.ai/a/x.png"] and img.size == (1024, 1536)
    assert meta == {"route": "tokensail", "model": "qwen-image-3.0-pro", "cost_usd": "0.0712"}


def test_dashscope_uses_the_galleries_own_protocol(monkeypatch):
    monkeypatch.delenv("TOKENSAIL_API_KEY", raising=False)
    monkeypatch.delenv("QWEN_API_BASE", raising=False)
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-dash")
    vendor = FakeVendor([OK_DASHSCOPE])
    paint.run_qwen("图1按图2摆姿势", ["https://x/a.jpg", "https://x/b.jpg"], 1024, 1536, {"negative_prompt": "文字", "prompt_extend": True}, vendor)
    url, headers, body = vendor.posts[0]
    assert url == "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
    assert body["model"] == "qwen-image-3.0-pro"
    assert body["input"]["messages"][0]["content"] == [{"image": "https://x/a.jpg"}, {"image": "https://x/b.jpg"}, {"text": "图1按图2摆姿势"}]
    assert body["parameters"] == {"size": "1024*1536", "n": 1, "prompt_extend": True, "watermark": False, "negative_prompt": "文字"}
    assert vendor.gets == ["https://dashscope-result.oss/x.png"]


def test_busy_answers_are_retried_and_refusals_say_why(tokensail):
    vendor = FakeVendor([Res(429, {"error": {"code": "rate_limited_rpm", "message": "slow down", "retry_class": "retryable"}}, headers={"Retry-After": "1"}), OK_TOKENSAIL])
    paint.run_qwen("a prompt here", [], 1024, 1024, {}, vendor)
    assert len(vendor.posts) == 2
    cases = [
        (Res(402, {"error": {"code": "balance_insufficient", "message": "top up"}}), "balance is used up"),
        (Res(401, {"error": {"code": "invalid_api_key", "message": "bad key"}}), "TOKENSAIL_API_KEY"),
        (Res(403, {"error": {"code": "model_not_allowed", "message": "no"}}), "may not use qwen-image-3.0-pro"),
        (Res(400, {"error": {"code": "upstream_client_error", "message": "DataInspectionFailed: Input data may contain inappropriate content."}}), "REFUSED by Alibaba Cloud"),
    ]
    for answer, words in cases:
        with pytest.raises(paint.PaintError, match=words):
            paint.run_qwen("a prompt here", [], 1024, 1024, {}, FakeVendor([answer]))


def test_no_key_no_qwen(monkeypatch):
    monkeypatch.delenv("TOKENSAIL_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    assert paint.qwen_route() is None
    with pytest.raises(paint.PaintError, match="needs TOKENSAIL_API_KEY"):
        paint.run_qwen("a prompt here", [], 1024, 1024, {}, FakeVendor([]))


def test_validation_and_settings():
    base = {"op": "paint", "prompt": "a picture", "size": "1024x1536", "backend": "qwen", "output": {"key": "projects/p/images/j.png"}}
    ok = paint.validate_paint_input({**base, "refs": ["https://x/1.png"] * 3, "params": {"api_model": "qwen-image-3.0-pro", "prompt_extend": True, "negative_prompt": " 文字 ", "steps": 4}})
    assert ok["settings"] == {"steps": 4, "api_model": "qwen-image-3.0-pro", "prompt_extend": True, "negative_prompt": "文字"}
    with pytest.raises(paint.PaintError, match="at most 3"):
        paint.validate_paint_input({**base, "refs": ["https://x/1.png"] * 4})
    assert "api_model" not in paint._settings({"api_model": "../../etc"})


def test_a_job_rehosts_its_references_mirrored_and_reports_the_cost(tokensail, tmp_path):
    left_red = Image.new("RGB", (40, 20), (255, 0, 0))
    left_red.paste((0, 0, 255), (20, 0, 40, 20))
    buf = io.BytesIO()
    left_red.save(buf, "PNG")

    class Http(FakeVendor):
        def get(self, url, stream=False, timeout=0, **kw):
            self.gets.append(url)
            return Res(content=buf.getvalue() if "gallery" in url else png((200, 30, 30), (1024, 1536)))

    class Up:
        def __init__(self):
            self.files = {}

        def upload(self, path, key, ctype):
            self.files[key] = (Image.open(path).copy(), ctype)
            return f"https://studio.test/media/{key}"

    vendor, up = Http([OK_TOKENSAIL]), Up()
    params = paint.validate_paint_input({"op": "paint", "prompt": "图1按图2摆姿势", "size": "1024x1536", "backend": "qwen", "output": {"key": "projects/p/images/j1.png"},
                                         "refs": ["https://gallery.test/a.png", "https://gallery.test/b.png"], "mirror_refs": [1], "studio_job_id": "j1",
                                         "params": {"api_model": "qwen-image-3.0-pro"}})
    out = paint.run_paint_job(params, up, tmp_path, http=vendor)
    ref0, ref1 = up.files["projects/p/images/j1.ref0.jpg"], up.files["projects/p/images/j1.ref1.jpg"]
    assert ref0[1] == "image/jpeg" and min(ref0[0].size) >= 384  # small pictures are brought up to the vendor's minimum
    assert ref0[0].getpixel((5, 5))[0] > 200 and ref1[0].getpixel((5, 5))[2] > 200  # the second one went up mirrored
    _, headers, body = vendor.posts[0]
    assert body["image"] == ["https://studio.test/media/projects/p/images/j1.ref0.jpg", "https://studio.test/media/projects/p/images/j1.ref1.jpg"]
    assert headers["X-TokenSail-Request-Id"] == "j1.r0"
    assert out["backend"] == "qwen" and out["api"] == [{"route": "tokensail", "model": "qwen-image-3.0-pro", "cost_usd": "0.0712"}]
    assert out["url"] == "https://studio.test/media/projects/p/images/j1.png"
