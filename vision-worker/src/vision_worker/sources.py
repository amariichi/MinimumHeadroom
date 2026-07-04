"""Frame sources.

`DirectoryFrameSource` replays JPEG/PNG files from a folder and is used for
offline development and tests. `NetworkFrameSource` pulls frames
over HTTP from the physical AtomS3R-M12.
"""

from __future__ import annotations

import glob
import os
import time
from typing import Iterator, Protocol


class FrameSource(Protocol):
    def frames(self) -> Iterator[bytes]:
        ...


class DirectoryFrameSource:
    def __init__(self, directory: str, interval_ms: int = 0, loop: bool = False) -> None:
        self.directory = directory
        self.interval_ms = interval_ms
        self.loop = loop

    def _paths(self) -> list[str]:
        paths: list[str] = []
        for pattern in ("*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"):
            paths.extend(glob.glob(os.path.join(self.directory, pattern)))
        return sorted(set(paths))

    def frames(self) -> Iterator[bytes]:
        paths = self._paths()
        if not paths:
            return
        while True:
            for path in paths:
                with open(path, "rb") as handle:
                    yield handle.read()
                if self.interval_ms > 0:
                    time.sleep(self.interval_ms / 1000.0)
            if not self.loop:
                return


class NetworkFrameSource:
    """Poll a snapshot URL on the AtomS3R-M12 over HTTP."""

    def __init__(self, url: str, interval_ms: int = 1500) -> None:
        self.url = url
        self.interval_ms = interval_ms

    def frames(self) -> Iterator[bytes]:
        import httpx

        while True:
            try:
                response = httpx.get(self.url, timeout=10.0)
                response.raise_for_status()
                yield response.content
            except Exception:  # noqa: BLE001 - keep polling through transient errors
                pass
            time.sleep(self.interval_ms / 1000.0)
