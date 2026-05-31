#!/usr/bin/env bash
# Build a SECRET-SAFE, distributable AtomS3R firmware image.
#
# Why this exists: the normal dev build includes
# firmware/atoms3r-headroom/include/headroom_config.local.h, which bakes YOUR
# Wi-Fi / auth token / PC URLs into the binary as compile-time string defaults
# (extractable with `strings firmware.bin`). That is fine for your own device but
# MUST NOT be published.
#
# This script:
#   1. forces the placeholder example config (temporarily disables local.h,
#      always restores it, even on error),
#   2. builds,
#   3. SCANS the artifacts and FAILS if any real value from your local.h leaked,
#   4. stages esp-web-tools artifacts (parts + manifest.json).
#
# NVS note: your real provisioned Wi-Fi / URLs / token live in the device's NVS
# partition, not in these app artifacts. End users flash this image and then
# provision their own settings (on-device setup portal, or scripts/atoms3r-provision.mjs).
#
# Usage:  scripts/build-release-firmware.sh [OUTPUT_DIR]   (default: dist/atoms3r-firmware)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FW_DIR="firmware/atoms3r-headroom"
LOCAL="$FW_DIR/include/headroom_config.local.h"
BUILD="$FW_DIR/.pio/build/m5stack-atoms3r"
OUT="${1:-dist/atoms3r-firmware}"

PIO="${PIO:-$REPO_ROOT/.venv-platformio/bin/pio}"
[ -x "$PIO" ] || PIO="$(command -v pio || true)"
[ -n "$PIO" ] || { echo "ERROR: pio not found (set PIO=/path/to/pio)"; exit 2; }

VERSION="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' package.json | head -1 | grep -oE '[0-9][^"]*' || echo 0.0.0)"

# 1) Collect the real (non-placeholder) secret values from local.h so we can
#    assert they are ABSENT from the built artifacts. (No values are printed.)
SECRETS=()
if [ -f "$LOCAL" ]; then
  for m in HEADROOM_WIFI_SSID HEADROOM_WIFI_PASSWORD \
           HEADROOM_WIFI_SSID2 HEADROOM_WIFI_PASSWORD2 \
           HEADROOM_WIFI_SSID3 HEADROOM_WIFI_PASSWORD3 \
           HEADROOM_FACE_AUTH_TOKEN HEADROOM_FACE_WS_URL \
           HEADROOM_FACE_HTTP_BASE HEADROOM_MDNS_HOST; do
    v="$(grep -oP "#define $m[[:space:]]+\"\K[^\"]*" "$LOCAL" 2>/dev/null | head -1 || true)"
    case "$v" in
      "" | your-wifi | your-password | \
      "http://192.168.1.10:8765" | "ws://192.168.1.10:8765/ws") ;;  # placeholder/empty → ignore
      *) SECRETS+=("$v") ;;
    esac
  done
fi

# 2) Build with the example config forced. local.h is restored on ANY exit.
restore_local() { [ -f "$LOCAL.release-off" ] && mv -f "$LOCAL.release-off" "$LOCAL" || true; }
trap restore_local EXIT
[ -f "$LOCAL" ] && mv "$LOCAL" "$LOCAL.release-off"
rm -f "$BUILD/firmware.bin" "$BUILD"/src/*.o 2>/dev/null || true   # force src recompile with example config
echo ">>> building AtomS3R firmware from EXAMPLE config (no local secrets) ..."
"$PIO" run -d "$FW_DIR"
restore_local
trap - EXIT
echo ">>> local.h restored: $([ -f "$LOCAL" ] && echo yes || echo '(was absent)')"

BIN="$BUILD/firmware.bin"
[ -f "$BIN" ] || { echo "ERROR: build produced no firmware.bin"; exit 1; }

# 3) Secret gate — none of your real local.h values may appear in any artifact.
#    Scan via a captured dump + here-string (NOT `strings | grep -q`): under
#    `set -o pipefail`, grep's early exit SIGPIPEs strings and would make the
#    pipeline "fail", silently flipping the result — a real leak could slip
#    through (fail-open). A here-string has no upstream pipe, so the test is
#    correct. Also refuse to trust an empty dump (broken/missing strings).
echo ">>> secret scan (${#SECRETS[@]} real value(s) from local.h to verify absent) ..."
leak=0
for art in "$BUILD/bootloader.bin" "$BUILD/partitions.bin" "$BIN"; do
  [ -f "$art" ] || continue
  dump="$(strings "$art")"
  [ -n "$dump" ] || { echo "ERROR: strings produced no output for $(basename "$art"); cannot verify"; exit 3; }
  for s in ${SECRETS+"${SECRETS[@]}"}; do
    [ -n "$s" ] || continue
    if grep -Fq -- "$s" <<<"$dump"; then
      echo "  ✗ LEAK: a real local.h value is embedded in $(basename "$art")"
      leak=1
    fi
  done
done
if ! grep -Fq "your-wifi" <<<"$(strings "$BIN")"; then
  echo "  ! warning: 'your-wifi' placeholder not found in firmware.bin — confirm the example config was used"
fi
if [ "$leak" -ne 0 ]; then
  echo ">>> ABORT: secrets leaked into the binary; refusing to publish."
  exit 1
fi
echo "  ✓ no real local.h value found in any artifact"

# 4) Stage esp-web-tools artifacts + manifest.
BOOT_APP0="$(find "${PLATFORMIO_CORE_DIR:-$HOME/.platformio}/packages/framework-arduinoespressif32" -name boot_app0.bin 2>/dev/null | head -1 || true)"
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$BUILD/bootloader.bin" "$BUILD/partitions.bin" "$BIN" "$OUT/"
if [ -n "$BOOT_APP0" ]; then
  cp "$BOOT_APP0" "$OUT/boot_app0.bin"
else
  echo "  ! warning: boot_app0.bin not found; copy it into $OUT/ before hosting (the device may not boot without it)"
fi

cat > "$OUT/manifest.json" <<JSON
{
  "name": "Minimum Headroom AtomS3R",
  "version": "${VERSION}",
  "new_install_prompt_erase": true,
  "builds": [
    {
      "chipFamily": "ESP32-S3",
      "parts": [
        { "path": "bootloader.bin", "offset": 0 },
        { "path": "partitions.bin", "offset": 32768 },
        { "path": "boot_app0.bin",  "offset": 57344 },
        { "path": "firmware.bin",   "offset": 65536 }
      ]
    }
  ]
}
JSON

# A ready-to-host esp-web-tools install page (loads the library from a CDN; no
# vendored third-party code). Web Serial requires Chrome/Edge over HTTPS (or
# localhost). NOTE: this board needs `--no-stub` for CLI flashing; whether
# esptool-js (used by esp-web-tools) flashes it is UNVERIFIED — test in Chrome
# before publishing the page.
cat > "$OUT/index.html" <<'HTML'
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Minimum Headroom — AtomS3R Installer</title>
  <script type="module" src="https://unpkg.com/esp-web-tools@10/dist/web/install-button.js?module"></script>
  <style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.6}</style>
</head>
<body>
  <h1>Install Minimum Headroom (AtomS3R)</h1>
  <p>Open this page in <b>Chrome or Edge</b> on a desktop, connect the AtomS3R over
     USB-C, then click <b>Install</b> and pick the device's serial port.</p>
  <p><esp-web-install-button manifest="manifest.json"></esp-web-install-button></p>
  <p><small>Web Serial works only in Chromium browsers, over HTTPS or localhost.
     After flashing, the device boots its <code>RMH-SETUP-XXXX</code> Wi-Fi access
     point — connect to it and set your Wi-Fi and server URL.</small></p>
</body>
</html>
HTML

echo ""
echo ">>> DONE — secret-safe artifacts (v${VERSION}) in: $OUT"
ls -la "$OUT"
echo ""
echo "To publish browser install: host the whole $OUT folder over HTTPS"
echo "(GitHub Pages, Netlify, …) and share index.html. It loads esp-web-tools from a CDN."
echo "End users flash, then provision their own Wi-Fi/URLs/token (setup portal or scripts/atoms3r-provision.mjs)."
echo "NOTE: verify esp-web-tools can flash this board (it needs --no-stub) in Chrome before relying on the page."
