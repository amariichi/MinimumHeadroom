"""GPU + model availability probes used to gate the continuous perception loop.

Kept tiny and dependency-light so the gating decision (see `perception.py`) can
be unit-tested by injecting fake values.
"""

from __future__ import annotations

import shutil
import subprocess


def free_vram_mb() -> int | None:
    """Free VRAM in MB via nvidia-smi, or None if it cannot be determined."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    try:
        out = subprocess.run(
            [exe, "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0 or not out.stdout.strip():
            return None
        return int(out.stdout.strip().splitlines()[0].strip())
    except Exception:  # noqa: BLE001
        return None


def model_healthy(base_url: str, timeout: float = 2.0) -> bool:
    """True if the OpenAI-compatible model endpoint answers /models."""
    import httpx

    try:
        resp = httpx.get(f"{base_url.rstrip('/')}/models", timeout=timeout)
        return resp.status_code == 200
    except Exception:  # noqa: BLE001
        return False
