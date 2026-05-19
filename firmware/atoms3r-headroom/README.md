# Real Minimum Headroom AtomS3R Firmware

This PlatformIO project is the AtomS3R hardware frontend for minimum-headroom.

Milestone 1 initializes the M5Stack AtomS3R display, draws a 128x128 parametric
face, and cycles expressions with the Atom button. Milestone 2 adds saved
settings and a setup access point. WebSocket mirroring and TTS playback are
implemented. The firmware also includes first-pass button PTT recording: hold
the Atom button while connected to Wi-Fi, speak, and release to send the
recorded WAV through `face-app` operator ASR.

## Build

```bash
cd firmware/atoms3r-headroom
pio run
```

## Flash

Put the AtomS3R in download mode if needed, then run:

```bash
pio run -t upload
pio device monitor
```

On the current AtomS3R hardware, flashing may require the esptool no-stub path:

```bash
PLATFORMIO_UPLOAD_FLAGS=--no-stub pio run -t upload --upload-port /dev/ttyACM0
```

Expected serial output:

```text
Real Minimum Headroom AtomS3R starting
display ready
demo face mode
```

Press the Atom button to cycle through neutral, thinking, speaking, listening,
permission, success, and failed expressions.

If Wi-Fi is not configured or cannot connect, the Atom starts a setup access
point such as `RMH-SETUP-1A2B` and shows the SSID plus `192.168.4.1` on the
display. Connect to that AP and open:

```text
http://192.168.4.1/
```

The setup page saves Wi-Fi, face app URLs, auth token, device id, display
priority agent id, input target agent id, ASR language, face rotation, placement
pose, and upper-side orientation to ESP32 NVS/Preferences.

## Multiple Wi-Fi networks (up to 3)

The firmware stores three Wi-Fi slots. At boot it tries slot 1, then slot 2,
then slot 3 (listed priority, ~8 s each) and connects to the first that works;
only if all configured slots fail does it fall back to the `RMH-SETUP-xxxx`
portal. Empty slots are skipped. Slot 1 keeps the original NVS keys, so an
already-provisioned device needs no migration. The setup portal exposes
"Wi-Fi SSID 2/3" and "Wi-Fi password 2/3".

## Reorient the face without a PC (triple-tap)

Tap the screen button **three times quickly** (each tap shorter than ~0.35 s,
within ~0.6 s of each other) to re-align the "up" direction. The new
orientation is saved to NVS and survives a power cycle, so you can physically
turn the device and re-align the face with no PC, portal, or reflash.

- **Screen tilted / standing up:** the IMU auto-detects which screen edge is
  up and snaps the face to the nearest of the 4 orientations.
- **Lying flat on a desk (screen up):** "up" is undecidable from gravity, so
  each triple-tap just steps the face +90° clockwise (keep tapping to reach
  the orientation you want).

The accelerometer-axis-to-panel mapping needs a one-time on-device
calibration. The easiest way (no reboot, no button) is the serial query:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --dry-run   # (any RMHCFG? client works)
# or send a raw `RMHCFG?\n` line; the STATE reply now includes:
#   "imu_enabled":true,"imu_ax":..,"imu_ay":..,"imu_az":..
```

Hold the device in each of the 4 intended uprights, read `imu_ax`/`imu_ay`
each time, and set `kImuRotationOffsetDeg` / `kImuRotationSign` in
`src/main.cpp` so the snapped angle matches the desired `rotation`. (The boot
log also prints `imu_enabled=...`, and each triple-tap prints
`imu accel x=.. y=.. z=.. inplane=..`, but the serial `RMHCFG?` path is
simpler.) Until calibrated, the flat-desk +90 step always works as a manual
fallback.

Hardware-verified 2026-05-19: `imu_enabled:true` with sane live accel on the
real AtomS3R; multi-slot Wi-Fi connect and the `RMHCFG` serial protocol work
on-device. The gesture *feel*, the audible cue, and the final calibration
constants still need a person at the device.

Push-to-talk is unchanged in feel but now **arms on a ~0.5 s hold** instead of
the press edge: hold the button, you hear a short "ピッ" cue the moment
recording arms, then speak. The beep is the "speak now" signal, so the short
arming delay does not clip your speech. Because a tap is shorter than the PTT
arm time, taps never open the microphone and a stray single tap no longer
flashes the Failed face. (Internally the cue tone is fully drained before the
shared ES8311 codec is switched to the mic, so the documented record/playback
corruption hazard is not reintroduced.)

## PC provisioning over USB (no portal typing)

With the AtomS3R plugged into the PC by USB-C, push Wi-Fi (×3), auth token,
and server URLs in one command instead of typing them into the portal:

```bash
node scripts/atoms3r-provision.mjs \
  --wifi "HomeSSID:homepass" --wifi "CafeSSID:cafepass" \
  --http-base http://192.168.1.10:8765 \
  --ws-url ws://192.168.1.10:8765/ws \
  --device-id atom-headroom-1 --reboot
```

The auth token is resolved automatically from `--token`, else
`MH_FACE_AUTH_TOKEN` in the environment, else the shared env file
`${MH_SHARED_ENV_FILE:-/home/amari1/.config/minimum-headroom.env}` — i.e. the
same source the running operator stack uses, so no extra setup is needed when
the stack is up. The script needs no npm dependency (it uses `stty` + the
device file). `--dry-run` prints the exact payload with secrets redacted and
never opens the port; `--help` lists all flags.

Under the hood the host and firmware exchange newline-terminated `RMHCFG`
lines on the existing USB CDC serial. `RMHCFG <json>` writes settings to NVS
(optional `"reboot":true`); `RMHCFG?` returns the current config with
passwords/token redacted to lengths only. The firmware listens for these at
any time in `loop()`, including while the setup portal is up.

When Wi-Fi connects successfully, the firmware opens the configured WebSocket
URL and mirrors these minimum-headroom payloads:

- `event`: changes expression for command start, success, failure, permission,
  retry, and idle states.
- `tts_state`: shows queued/speaking/error/idle state.
- `tts_mouth`: drives mouth openness from the payload's `open` value.

When Wi-Fi is connected, the Atom button is used for push-to-talk instead of the
offline expression demo. Hold the button to record up to 8 seconds of 16 kHz mono
PCM from the Atomic Echo Base microphone. On release, the firmware wraps the clip
as `audio/wav`, posts it to:

```text
<Face HTTP base>/api/operator/asr?lang=<ASR language>
```

If ASR returns non-empty text, the Atom sends an `operator_response` websocket
payload with `source: "atom"` and `response_kind: "text"`. If the Atom-to-PC
WebSocket is unavailable, it falls back to authenticated HTTP:

```text
<Face HTTP base>/api/operator/response
```

Recording and speaker playback are serialized because the Atomic Echo Base uses
one ES8311 codec for both mic and speaker.

The normal-mode health endpoint is useful for desk debugging:

```text
http://<atom-ip>/health
```

It reports the configured face HTTP/WS URLs, ASR language, auth presence, and
whether the Atom-originated WebSocket is connected. The auth token value is not
returned.

If `MH_FACE_AUTH_TOKEN` is enabled on the PC, set the same token in the setup
page. The firmware appends it as `auth_token` on the WebSocket URL for the
same-LAN first implementation.

The default display priority agent is `__operator__`. TTS/status payloads from
other agents are still accepted, but recent operator payloads get a short
priority window so helper speech does not immediately overwrite the physical
operator face. Future Atom input payloads should target `__operator__` by
default and must not directly target helper panes unless explicitly configured.

## Local Settings

The checked-in `include/headroom_config.example.h` contains safe placeholders.
For development-only defaults, create `include/headroom_config.local.h`; it is
ignored by git. Runtime settings are loaded from NVS/Preferences when present,
and the Atom-hosted setup portal can update Wi-Fi, server URL, auth token, ASR
language, and orientation without reflashing.
