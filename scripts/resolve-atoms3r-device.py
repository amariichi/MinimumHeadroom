#!/usr/bin/env python3
"""Resolve an AtomS3R device URL using the vision-worker discovery module."""

from __future__ import annotations

import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "vision-worker", "src"))

from vision_worker.device_discovery import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
