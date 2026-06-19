"""On-disk frame storage.

The continuous OCR/overview text is only a fast, possibly-imperfect index. The
*answers* to accuracy-sensitive questions ("solve problem 12") come from
re-reading the original full-resolution frame, so we keep the original encoded
bytes verbatim plus a small thumbnail. The database stores only paths.
"""

from __future__ import annotations

import os
import time
import uuid

from .imaging import load_rgb


class FrameStore:
    def __init__(self, cache_dir: str, thumb_max: int = 256) -> None:
        self.frames_dir = os.path.join(cache_dir, "frames")
        self.thumbs_dir = os.path.join(cache_dir, "thumbs")
        self.thumb_max = thumb_max
        os.makedirs(self.frames_dir, exist_ok=True)
        os.makedirs(self.thumbs_dir, exist_ok=True)

    def save(self, frame_jpeg: bytes) -> tuple[str, str, int, int]:
        """Persist the original frame and a thumbnail.

        Returns (full_path, thumb_path, width, height). The original encoded
        bytes are written unchanged to preserve resolution for later re-reads.
        """
        img = load_rgb(frame_jpeg)
        width, height = img.size
        name = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:8]}.jpg"

        full_path = os.path.join(self.frames_dir, name)
        with open(full_path, "wb") as handle:
            handle.write(frame_jpeg)

        thumb = img.copy()
        thumb.thumbnail((self.thumb_max, self.thumb_max))
        thumb_path = os.path.join(self.thumbs_dir, name)
        thumb.save(thumb_path, "JPEG", quality=80)

        return full_path, thumb_path, width, height

    def remove(self, *paths: str | None) -> None:
        for path in paths:
            if not path:
                continue
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                pass
