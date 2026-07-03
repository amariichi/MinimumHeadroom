"""Cheap CPU-side change gate.

Decides whether a new frame differs enough from the previous one to be worth
sending to the vision model. This protects the GPU from re-processing static
scenes and keeps the database from filling with duplicates. It combines a
perceptual average-hash (robust to small lighting jitter) with a downscaled
mean-absolute pixel difference (catches changes the coarse hash misses).
"""

from __future__ import annotations

import numpy as np

from .imaging import average_hash, hamming, small_gray


class ChangeGate:
    def __init__(
        self,
        hash_size: int = 8,
        hamming_threshold: int = 6,
        pixel_diff_threshold: float = 0.06,
        steady_frames: int = 2,
    ) -> None:
        self._hash_size = hash_size
        self._hamming_threshold = hamming_threshold
        self._pixel_diff_threshold = pixel_diff_threshold
        self._steady_frames = steady_frames
        self._last_hash: int | None = None
        self._last_small: np.ndarray | None = None
        self._steady_count = 0

    def is_changed(self, frame_jpeg: bytes) -> bool:
        current_hash = average_hash(frame_jpeg, self._hash_size)
        current_small = small_gray(frame_jpeg, 32)

        if self._last_hash is None or self._last_small is None:
            changed = True
        else:
            ham = hamming(current_hash, self._last_hash)
            pix = float(np.abs(current_small - self._last_small).mean())
            changed = ham > self._hamming_threshold or pix > self._pixel_diff_threshold

        self._last_hash = current_hash
        self._last_small = current_small
        if changed:
            self._steady_count = 0
        else:
            self._steady_count += 1
        return changed

    def scene_is_steady(self) -> bool:
        """True once the scene has been unchanged for `steady_frames` frames.

        Used by temporal voting to decide when it is safe to
        reconcile several frames of the same scene.
        """
        return self._steady_count >= self._steady_frames

    @property
    def last_hash(self) -> int | None:
        """The integer average-hash of the most recently gated frame.

        Reused by the pipeline to anchor human corrections to the live scene
        without hashing the frame a second time.
        """
        return self._last_hash

    @property
    def last_hash_hex(self) -> str | None:
        if self._last_hash is None:
            return None
        return format(self._last_hash, "x")
