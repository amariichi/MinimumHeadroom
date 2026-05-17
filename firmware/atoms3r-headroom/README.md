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
