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
    def __init__(self, url: str, timeout: float = 10.0) -> None:
        self.url = url
        self.timeout = timeout

    def capture(self) -> bytes | None:
        import httpx

        resp = httpx.get(self.url, timeout=self.timeout)
        resp.raise_for_status()
        return resp.content


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
        return NetworkCaptureSource(settings.camera_url)
    if settings.frame_dir:
        return DirectoryCaptureSource(settings.frame_dir)
    return None
