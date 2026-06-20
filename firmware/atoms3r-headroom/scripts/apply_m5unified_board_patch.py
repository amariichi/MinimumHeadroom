"""PlatformIO pre-build hook (env:atoms3r-m12 only): force the AtomS3R-M12 to be
detected as board_M5AtomS3RCam instead of board_M5AtomVoiceS3R.

Why: the M12 is an AtomS3R + OV3660 camera + Atomic Echo Base, with no LCD.
M5Unified's board auto-detection (M5Unified.cpp, ESP32-S3-PICO case) probes for
the ES8311 first and, finding it, returns board_M5AtomVoiceS3R *before* it ever
runs the camera probe. On that board M5Unified drives the speaker I2S on
GPIO 17/3/48 — which are the OV3660's data lines — and uses an integrated-codec
init that never enables the Echo Base's PI4IOE power amp, so playback is silent /
hiss. board_M5AtomS3RCam instead selects the atomic_echo speaker path
(I2S bck=8/ws=6/dout=5, disjoint from the camera; ES8311 control time-shared on
I2C port 1 pins 38/39; PI4IOE PA enabled), which drives the Echo Base correctly
and coexists with the camera.

The assignment `board = board_t::board_M5AtomVoiceS3R;` is unique in the file
(the other board_M5AtomVoiceS3R occurrences are array entries `{ board_t::... }`
and `case board_t::...:` labels), so a plain substring replace is safe. The hook
is idempotent (self-marking) and fails loudly if the upstream line is gone, so a
future M5Unified upgrade cannot silently regress the fix.
"""

from __future__ import annotations

import os
import sys

Import("env")  # type: ignore[name-defined]  # provided by PlatformIO/SCons

TAG = "[m5unified-m12-board-patch]"
MARKER = "HEADROOM-M12 PATCH"
ORIGINAL = "board = board_t::board_M5AtomVoiceS3R;"
REPLACEMENT = (
    "board = board_t::board_M5AtomS3RCam;  // "
    + MARKER
    + ": AtomS3R+camera+EchoBase -> atomic_echo audio path (was board_M5AtomVoiceS3R)"
)


def _log(msg: str) -> None:
    print(f"{TAG} {msg}")


def _resolve_target() -> str:
    libdeps = env.subst("$PROJECT_LIBDEPS_DIR")  # type: ignore[name-defined]
    pioenv = env["PIOENV"]  # type: ignore[name-defined]
    target = os.path.join(libdeps, pioenv, "M5Unified", "src", "M5Unified.cpp")
    if not os.path.isfile(target):
        raise RuntimeError(
            f"expected M5Unified.cpp at {target}; the M5Unified library may not "
            "be installed yet or its layout changed."
        )
    return target


def _apply_patch() -> None:
    target = _resolve_target()
    with open(target, "r", encoding="utf-8") as f:
        content = f.read()

    if MARKER in content:
        _log(f"already applied: {target}")
        return

    if ORIGINAL not in content:
        raise RuntimeError(
            "M5Unified.cpp does not contain the expected board-detection line "
            f"'{ORIGINAL}'. The library version may have changed; inspect the "
            f"ESP32-S3-PICO detection block by hand. Target: {target}"
        )

    patched = content.replace(ORIGINAL, REPLACEMENT, 1)
    if patched == content:
        raise RuntimeError("patch replacement produced no change; aborting.")

    with open(target, "w", encoding="utf-8") as f:
        f.write(patched)
    _log(f"applied: {target}")


try:
    _apply_patch()
except Exception as exc:  # noqa: BLE001 - bubble a single clear message
    print(f"{TAG} ERROR: {exc}", file=sys.stderr)
    sys.exit(1)
