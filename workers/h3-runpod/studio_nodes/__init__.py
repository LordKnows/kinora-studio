"""Cinema Studio helper nodes for ComfyUI (installed into custom_nodes/ at boot).

StudioH3VideoLatent: the MiniMax H3 audio+video latent that the
Open-H3-Regenerate nodes build is a NestedTensor (video, audio). ComfyUI
builds before 0.42 cannot hand that to the core video VAE, so this node
keeps the video half only; the soundtrack is muxed back in afterwards.
"""

from __future__ import annotations

from typing import Any


def video_part(samples: Any) -> Any:
    """First component of a nested (video, audio) latent; a plain tensor passes through."""
    tensors = getattr(samples, "tensors", None)
    if isinstance(tensors, (list, tuple)) and tensors:
        return tensors[0]
    unbind = getattr(samples, "unbind", None)
    if callable(unbind) and getattr(samples, "is_nested", False):
        parts = unbind()
        if parts:
            return parts[0]
    if isinstance(samples, (list, tuple)) and samples:
        return samples[0]
    return samples


class StudioH3VideoLatent:
    @classmethod
    def INPUT_TYPES(cls):  # noqa: N802 — ComfyUI convention
        return {"required": {"samples": ("LATENT", {"tooltip": "H3 audio+video latent; the video half comes out."})}}

    RETURN_TYPES = ("LATENT",)
    RETURN_NAMES = ("samples",)
    FUNCTION = "split"
    CATEGORY = "MiniMax H3/Cinema Studio"

    def split(self, samples: dict[str, Any]) -> tuple[dict[str, Any]]:
        out = dict(samples)
        out["samples"] = video_part(samples["samples"])
        return (out,)


NODE_CLASS_MAPPINGS = {"StudioH3VideoLatent": StudioH3VideoLatent}
NODE_DISPLAY_NAME_MAPPINGS = {"StudioH3VideoLatent": "Cinema Studio · H3 video latent (drop audio)"}
