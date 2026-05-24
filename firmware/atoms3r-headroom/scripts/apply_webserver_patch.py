"""PlatformIO pre-build hook: cap the ESP32 Arduino WebServer raw-upload read
size to the remaining body bytes.

Why: the upstream loop calls client.readBytes(buf, HTTP_RAW_BUFLEN) on every
iteration, so the final partial chunk blocks for the full 5 s WiFiClient
timeout (HTTP_MAX_SEND_WAIT). On AtomS3R this adds a fixed ~5 s tail to every
audio POST, making chunked TTS playback chop.

The change is small and self-marking. The hook is idempotent and fails loudly
if the upstream file no longer matches, so a future framework upgrade will not
silently regress the fix.

See patches/webserver_raw_read_cap.patch for the human-readable diff and
README.md ("WebServer library patch") for the full explanation.
"""

from __future__ import annotations

import os
import sys

Import("env")  # type: ignore[name-defined]  # provided by PlatformIO/SCons

MARKER = "PATCH(minimum-headroom):"
ORIGINAL = (
    "      while (_currentRaw->totalSize < _clientContentLength) {\n"
    "        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, HTTP_RAW_BUFLEN);\n"
    "        _currentRaw->totalSize += _currentRaw->currentSize;\n"
)
REPLACEMENT = (
    "      while (_currentRaw->totalSize < _clientContentLength) {\n"
    "        // PATCH(minimum-headroom): cap readBytes() to remaining bytes so the\n"
    "        // final partial chunk does not wait the full 5s WiFiClient timeout.\n"
    "        size_t toRead = HTTP_RAW_BUFLEN;\n"
    "        size_t remaining = _clientContentLength - _currentRaw->totalSize;\n"
    "        if (remaining < toRead) toRead = remaining;\n"
    "        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, toRead);\n"
    "        _currentRaw->totalSize += _currentRaw->currentSize;\n"
)

TAG = "[webserver-patch]"


def _log(msg: str) -> None:
    print(f"{TAG} {msg}")


def _resolve_target() -> str:
    platform = env.PioPlatform()  # type: ignore[name-defined]
    framework_dir = platform.get_package_dir("framework-arduinoespressif32")
    if not framework_dir or not os.path.isdir(framework_dir):
        raise RuntimeError(
            "framework-arduinoespressif32 package directory not found; "
            "install it via PlatformIO first."
        )
    target = os.path.join(
        framework_dir, "libraries", "WebServer", "src", "Parsing.cpp"
    )
    if not os.path.isfile(target):
        raise RuntimeError(
            f"expected WebServer Parsing.cpp at {target}; framework layout may "
            "have changed. See firmware/atoms3r-headroom/README.md."
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
            "WebServer Parsing.cpp does not contain the expected upstream "
            "snippet. The framework version may have changed. Inspect "
            "patches/webserver_raw_read_cap.patch and apply by hand. Target: "
            f"{target}"
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
