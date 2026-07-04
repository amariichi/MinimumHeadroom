"""Small image helpers shared by the change gate, the mock model, and storage.

All functions take raw encoded image bytes (JPEG/PNG) so callers never have to
manage Pillow objects. The "average hash" here is a cheap perceptual
fingerprint: downscale to a tiny grayscale grid, threshold each pixel against
the grid mean, and pack the bits into an integer. Two visually similar images
produce hashes that differ in only a few bits (small Hamming distance).
"""

from __future__ import annotations

import io

import numpy as np
from PIL import Image


def load_image(data: bytes) -> Image.Image:
    """Decode encoded image bytes into a Pillow image (original mode)."""
    return Image.open(io.BytesIO(data))


def load_rgb(data: bytes) -> Image.Image:
    """Decode encoded image bytes into an RGB Pillow image."""
    return load_image(data).convert("RGB")


def average_hash(data: bytes, hash_size: int = 8) -> int:
    """Return a perceptual average-hash of the image as an integer bitfield."""
    img = load_image(data).convert("L").resize((hash_size, hash_size), Image.BILINEAR)
    arr = np.asarray(img, dtype=np.float64)
    bits = (arr > arr.mean()).flatten()
    value = 0
    for bit in bits:
        value = (value << 1) | int(bit)
    return value


def hamming(a: int, b: int) -> int:
    """Number of differing bits between two integer hashes."""
    return bin(a ^ b).count("1")


def small_gray(data: bytes, size: int = 32) -> np.ndarray:
    """Downscaled grayscale array in [0, 1] for cheap pixel-difference scoring."""
    img = load_image(data).convert("L").resize((size, size), Image.BILINEAR)
    return np.asarray(img, dtype=np.float64) / 255.0


def text_likeness(data: bytes) -> float:
    """Fraction of near-black + near-white pixels.

    Pages of text are strongly bimodal (dark ink on light paper), so a high
    value is a cheap hint that a frame is "text" rather than a scene. Used only
    by the offline `MockModelClient`; the real model decides `is_text` itself.
    """
    arr = small_gray(data, 48)
    dark = float((arr < 0.25).mean())
    light = float((arr > 0.75).mean())
    return dark + light
