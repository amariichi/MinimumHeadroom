"""Shared test helpers: synthetic frames generated in-process (no binary fixtures)."""

from __future__ import annotations

import io

import pytest
from PIL import Image, ImageDraw


def _encode(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def _make_frame(seed: int, size: int = 96) -> bytes:
    """A 4x4 grid of black cells selected by the 16 bits of `seed`.

    Distinct seeds give distinct spatial patterns, hence distinct perceptual
    hashes and distinct mock OCR text. Bimodal (black on white) so the mock
    treats it as text.
    """
    img = Image.new("RGB", (size, size), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    cell = size // 4
    for i in range(16):
        if (seed >> i) & 1:
            row, col = divmod(i, 4)
            draw.rectangle(
                [col * cell, row * cell, (col + 1) * cell - 1, (row + 1) * cell - 1],
                fill=(0, 0, 0),
            )
    return _encode(img)


def _make_scene(seed: int, size: int = 96) -> bytes:
    """A mid-tone frame (not bimodal) so the mock treats it as a scene, not text."""
    img = Image.new("RGB", (size, size), (110, 120, 130))
    draw = ImageDraw.Draw(img)
    cell = size // 4
    row, col = divmod(seed % 16, 4)
    draw.rectangle(
        [col * cell, row * cell, (col + 1) * cell - 1, (row + 1) * cell - 1],
        fill=(150, 140, 120),
    )
    return _encode(img)


@pytest.fixture
def make_frame():
    return _make_frame


@pytest.fixture
def make_scene():
    return _make_scene
