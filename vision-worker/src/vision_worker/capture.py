"""One-shot capture sources for on-demand frames (Mode A) and the loop (Mode B).

`NetworkCaptureSource` pulls a single frame from the AtomS3R-M12 snapshot URL.
`DirectoryCaptureSource` cycles through image files for development/tests while
the physical camera is not available.
"""

from __future__ import annotations

import glob
import os
from typing import Protocol


class CaptureSource(Protocol):
    def capture(self) -> bytes | None:
        ...


class NetworkCaptureSource:
    def __init__(self, url: str, timeout: float = 10.0, rotate_ccw: int = 0) -> None:
        self.url = url
        self.timeout = timeout
        # Degrees counterclockwise to rotate each frame. The AtomS3R-M12 held
        # USB-port-down delivers a frame rotated 90deg from upright (the sensor
        # already undoes the left-right mirror via hmirror, but cannot rotate),
        # so the consumer rotates it here. Normalised to {0, 90, 180, 270}.
        self.rotate_ccw = rotate_ccw % 360

    def capture(self) -> bytes | None:
        import httpx

        resp = httpx.get(self.url, timeout=self.timeout)
        resp.raise_for_status()
        return self._rotate(resp.content)

    def _rotate(self, data: bytes) -> bytes:
        if self.rotate_ccw % 360 == 0:
            return data
        import io

        from PIL import Image

        with Image.open(io.BytesIO(data)) as im:
            rotated = im.rotate(self.rotate_ccw, expand=True)
            out = io.BytesIO()
            rotated.convert("RGB").save(out, format="JPEG", quality=85)
            return out.getvalue()


class DirectoryCaptureSource:
    """Dev/test source: returns image files in rotation."""

    def __init__(self, directory: str) -> None:
        self.directory = directory
        self._i = 0

    def _paths(self) -> list[str]:
        paths: list[str] = []
        for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
            paths.extend(glob.glob(os.path.join(self.directory, pattern)))
        return sorted(set(paths))

    def capture(self) -> bytes | None:
        paths = self._paths()
        if not paths:
            return None
        path = paths[self._i % len(paths)]
        self._i += 1
        with open(path, "rb") as handle:
            return handle.read()


def build_capture_source(settings) -> CaptureSource | None:
    if settings.camera_url:
        return NetworkCaptureSource(
            settings.camera_url, rotate_ccw=getattr(settings, "camera_rotate", 0)
        )
    if settings.frame_dir:
        return DirectoryCaptureSource(settings.frame_dir)
    return None
