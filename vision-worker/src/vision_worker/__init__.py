"""minimum-headroom vision-worker.

Continuous camera perception for the AtomS3R-M12 camera kit: pull frames,
gate on visual change, ask a vision-language model for a structured record
(full OCR + scene overview + change-from-previous), and keep a small rolling
memory in SQLite that cloud agents query through a skill + HTTP API.

This package is GPU-free by default: the perception model is swappable, and
the bundled `MockModelClient` lets the whole pipeline run and be tested
without a GPU. See `.agent/execplans/atoms3r-m12-vision-memory.md`.
"""

from __future__ import annotations

__version__ = "0.1.0"
