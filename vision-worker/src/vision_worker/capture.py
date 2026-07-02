"""One-shot capture sources for on-demand frames (Mode A) and the loop (Mode B).

`NetworkCaptureSource` pulls a single frame from the AtomS3R-M12 snapshot URL.
`DirectoryCaptureSource` cycles through image files for development/tests while
the physical camera is not available.
"""

from __future__ import annotations

import glob
import os
from typing import Callable, Protocol

from .device_discovery import is_auto, resolve_device_url


class CaptureSource(Protocol):
    def capture(self) -> bytes | None:
        ...


class NetworkCaptureSource:
    def __init__(
        self,
        url: str,
        timeout: float = 10.0,
        rotate_ccw: int = 0,
        *,
        resolver: Callable[[], str | None] | None = None,
        rediscover_after_failures: int = 5,
        auth_token: str | None = None,
    ) -> None:
        self.url = url
        self.timeout = timeout
        self.resolver = resolver
        self.rediscover_after_failures = max(1, rediscover_after_failures)
        self._consecutive_failures = 0
        # The firmware's /snapshot requires the provisioned device token; sent
        # as X-Headroom-Auth so discovery-resolved URLs stay token-free.
        self.auth_token = (auth_token or "").strip() or None
        # Degrees counterclockwise to rotate each frame. The AtomS3R-M12 held
        # USB-port-down delivers a frame rotated 90deg from upright (the sensor
        # already undoes the left-right mirror via hmirror, but cannot rotate),
        # so the consumer rotates it here. Normalised to {0, 90, 180, 270}.
        self.rotate_ccw = rotate_ccw % 360

    def _headers(self) -> dict[str, str]:
        return {"X-Headroom-Auth": self.auth_token} if self.auth_token else {}

    def capture(self) -> bytes | None:
        import httpx

        try:
            resp = httpx.get(self.url, timeout=self.timeout, headers=self._headers())
            resp.raise_for_status()
        except Exception:
            self._consecutive_failures += 1
            if self.resolver is not None and self._consecutive_failures >= self.rediscover_after_failures:
                new_url = self.resolver()
                self._consecutive_failures = 0
                if new_url and new_url != self.url:
                    self.url = new_url
                    resp = httpx.get(self.url, timeout=self.timeout, headers=self._headers())
                    resp.raise_for_status()
                    return self._rotate(resp.content)
            raise
        self._consecutive_failures = 0
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
    resolver = None
    device_id = getattr(settings, "camera_resolve_device_id", None)
    if device_id:
        resolver = lambda: resolve_device_url(device_id, "/snapshot", refresh=True)
    auth_token = getattr(settings, "camera_auth_token", None)

    if settings.camera_url and not is_auto(settings.camera_url):
        return NetworkCaptureSource(
            settings.camera_url,
            rotate_ccw=getattr(settings, "camera_rotate", 0),
            resolver=resolver,
            rediscover_after_failures=getattr(settings, "camera_rediscover_after_failures", 5),
            auth_token=auth_token,
        )
    if resolver is not None and (settings.camera_url is None or is_auto(settings.camera_url)):
        return NetworkCaptureSource(
            resolver(),
            rotate_ccw=getattr(settings, "camera_rotate", 0),
            resolver=resolver,
            rediscover_after_failures=getattr(settings, "camera_rediscover_after_failures", 5),
            auth_token=auth_token,
        )
    if settings.frame_dir:
        return DirectoryCaptureSource(settings.frame_dir)
    return None
