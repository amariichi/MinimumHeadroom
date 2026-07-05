# AtomS3R-M12 Camera Firmware — Integration Spec

> **This is the AtomS3R-M12 (camera + voice output) firmware.** For the other
> device — the face AtomS3R (face + voice I/O) — and how the two relate, see
> [AtomS3R Devices](../../../doc/guides/atom-devices.md). For the M12 *software*
> side (vision worker, situation memory), see
> [M12 Vision Guide](../../../doc/guides/m12-vision.md).

Status: **validated on real hardware.** This started as a specification written
before the device was in hand; the camera firmware has since been flashed and
run on a real AtomS3R-M12 — the camera pin map is confirmed on real silicon and
audio and camera coexist without glitches (the mic bus is briefly borrowed for
camera SCCB, see below). This document keeps the design detail and the verified
pin maps as the firmware reference.

This spec extends the existing firmware project `firmware/atoms3r-headroom/`
(the `atoms3r-m12` PlatformIO env). See its `README.md` and
`../../../doc/guides/atoms3r-voice.md` for the audio path, the WebServer patch,
provisioning, and the release build.

<a id="japanese"></a>

## 日本語（概要）

これは **AtomS3R-M12（カメラ＋音声出力）** のファームウェア仕様です。もう一方の
**顔 AtomS3R（顔＋音声入出力）** との関係は
[AtomS3R Devices](../../../doc/guides/atom-devices.md#japanese) を、M12 の**ソフト側**
（vision worker・状況メモリ）は
[M12 Vision Guide](../../../doc/guides/m12-vision.md#japanese) を参照してください。
本文書は実機で動作確認済みのファーム仕様（カメラのピンマップ、音声とカメラの共存など）
を英語で詳述しています。M12 は同じ `firmware/atoms3r-headroom/` プロジェクトの
`atoms3r-m12` env でビルドします（顔は `m5stack-atoms3r` env）。

## What the M12 firmware is

The faced AtomS3R is a screen + audio device. The AtomS3R-M12 is the same
controller (ESP32-S3-PICO-1-N8R8, 8MB flash / 8MB PSRAM) with an **OV3660 3MP
M12 camera and no LCD**, fitted with the same Atomic Echo Base (ES8311 mic +
speaker). So the M12 firmware is:

  existing audio firmware  −  screen/face/IMU/screen-button code  +  camera

Concretely, **reuse** these existing modules unchanged: `headroom_audio`
(ES8311 via M5Unified), `headroom_continuous_vad` (Silero/RMS VAD — the
standalone input path), `headroom_transport` (WebSocket to face-app),
`headroom_ingress_server` (receives TTS audio + its WebServer), `headroom_settings`,
`headroom_setup_portal` + `headroom_serial_provision` (Wi-Fi provisioning), and
mDNS. **Drop / compile out** these (the M12 has no screen and only a reset
button): `face_renderer` (LCD face), the IMU face-rotation logic in `main.cpp`,
and the screen-button PTT/tap gestures in `headroom_ptt`. Per the v1 operating
model, the M12 standalone uses hands-free VAD; push-to-talk is only used when
the M12 is paired with the faced unit, and a future Grove button (Unit U027/U025
on the HY2.0 port, pins G1/G2) can add an on-device PTT/mute later.

## Verified camera pin map (OV3660 → ESP32-S3-PICO-1-N8R8)

Confirmed against two M5Stack sources that agree exactly (the AtomS3R-M12 doc
pin table and the M5Stack ESPHome example):

| Camera signal | GPIO | | Camera signal | GPIO |
|---|---|---|---|---|
| XCLK | 21 (20 MHz) | | Y2 / D0 | 3 |
| PCLK | 40 | | Y3 / D1 | 42 |
| VSYNC | 10 | | Y4 / D2 | 46 |
| HREF | 14 | | Y5 / D3 | 48 |
| SIOD / SDA (SCCB) | 12 | | Y6 / D4 | 4 |
| SIOC / SCL (SCCB) | 9 | | Y7 / D5 | 17 |
| PWDN / POWER_N | 18 | | Y8 / D6 | 11 |
| RESET | -1 (none; SCCB soft reset) | | Y9 / D7 | 13 |

`esp_camera` config to use (design reference — implement in `headroom_camera`):

    camera_config_t cfg = {};
    cfg.pin_pwdn = 18;  cfg.pin_reset = -1;  cfg.pin_xclk = 21;
    cfg.pin_sccb_sda = 12;  cfg.pin_sccb_scl = 9;
    cfg.pin_d0 = 3;  cfg.pin_d1 = 42; cfg.pin_d2 = 46; cfg.pin_d3 = 48;
    cfg.pin_d4 = 4;  cfg.pin_d5 = 17; cfg.pin_d6 = 11; cfg.pin_d7 = 13;
    cfg.pin_vsync = 10; cfg.pin_href = 14; cfg.pin_pclk = 40;
    cfg.xclk_freq_hz = 20000000;
    cfg.pixel_format = PIXFORMAT_JPEG;
    cfg.frame_size   = FRAMESIZE_SVGA;        // continuous index; see below
    cfg.jpeg_quality = 12;                    // 10..14 reasonable
    cfg.fb_count     = 2;
    cfg.fb_location  = CAMERA_FB_IN_PSRAM;    // 8MB PSRAM present
    cfg.grab_mode    = CAMERA_GRAB_LATEST;

OV3660 is 3MP; for the accuracy-sensitive OCR path the snapshot endpoint can
switch the sensor to a larger frame size on demand (e.g. `FRAMESIZE_QXGA`
2048x1536) while the continuous loop stays at SVGA/XGA to keep it light.

## Echo Base pin map and the pin-conflict check (the key coexistence question)

The Atomic Echo Base (ES8311) on the Atom socket uses these GPIO on AtomS3 /
AtomS3R (from the M5Atomic-EchoBase library):

| Audio signal | GPIO |
|---|---|
| I2C SDA (ES8311 control) | 38 |
| I2C SCL (ES8311 control) | 39 |
| I2S DIN (mic / ASDOUT) | 7 |
| I2S WS / LRCK | 6 |
| I2S DOUT (speaker) | 5 |
| I2S BCK / SCLK | 8 |

**Pin-conflict analysis.** Audio uses {5, 6, 7, 8, 38, 39}. The camera uses
{3, 4, 9, 10, 11, 12, 13, 14, 17, 18, 21, 40, 42, 46, 48}. The two sets are
**disjoint — there is no GPIO overlap.** Audio and camera can therefore coexist
on the AtomS3R-M12 with no pin remapping. (This must still be confirmed on real
hardware, but it removes the single biggest blocker on paper.)

The audio pins are owned by M5Unified's `M5.Speaker` / `M5.Mic`, not hard-coded
in this firmware, so adding the camera does not touch the proven audio path.

## Build environment plan

Add a second PlatformIO environment to
`firmware/atoms3r-headroom/platformio.ini` that shares the same sources:

    [env:atoms3r-m12]
    extends = env:m5stack-atoms3r            ; reuse platform/board/flags/patch
    build_flags =
      ${env:m5stack-atoms3r.build_flags}
      -DHEADROOM_M12                          ; select the M12 variant
      -DHEADROOM_NO_DISPLAY                   ; compile out LCD/face/IMU/screen-PTT
    lib_deps =
      ${env:m5stack-atoms3r.lib_deps}
      espressif/esp32-camera                  ; OV3660 driver

Guard the screen-coupled code with `#ifndef HEADROOM_NO_DISPLAY` in `main.cpp`
(the `renderer.*` calls, the IMU face-rotation block, and the screen-button
gesture handling) and `#ifdef HEADROOM_M12` to start the camera. Keep the
faced-AtomS3R build (`env:m5stack-atoms3r`) byte-for-byte unchanged so the
proven firmware is never at risk.

## New module: `headroom_camera`

Add `src/headroom_camera.{h,cpp}` providing:

- `begin()` — `esp_camera_init(&cfg)` with the pin map above; on failure, log
  and continue (audio/VAD must still work).
- An HTTP route on the **existing** WebServer (the one
  `headroom_ingress_server` already runs) so there is a single server and the
  WebServer patch still applies. Routes:
  - `GET /snapshot` → one JPEG frame (`esp_camera_fb_get()` → send → `..._return`).
  - optional `GET /snapshot?full=1` → temporarily raise frame size to QXGA for an
    OCR-grade capture, then restore.
- The camera serves only in **station mode** (joined to Wi-Fi / reachable over
  Tailscale); it is not exposed in the setup-portal AP mode.

The PC side (`vision-worker`) points `VISION_CAMERA_URL` at
`http://<m12-ip-or-tailscale>/snapshot` (the `NetworkFrameSource` already polls a
snapshot URL).

## Coexistence test plan (the real hardware risk)

With pins disjoint, the remaining risk is **resource contention** on one
ESP32-S3: PSRAM bandwidth (camera framebuffers + audio buffers both in PSRAM),
DMA (I2S DMA for audio vs the camera's parallel-capture DMA), and CPU. At the
target ~0.5 fps this is expected to be fine, but verify on hardware:

1. Flash, join Wi-Fi, confirm `GET /snapshot` returns a valid JPEG.
2. With TTS playing and VAD capturing, poll `/snapshot` every 2 s and listen for
   audio glitches / dropouts; watch the serial log for I2S underruns.
3. If glitches appear: keep the continuous frame size small (SVGA), capture
   full-res only on demand, pin the camera/HTTP work to core 0 and the audio
   task to core 1, and/or lower the capture rate. As a last resort, capture
   on-demand only (no continuous loop) and let the PC request frames.

## Flashing & validation (deferred until the device arrives)

Build now (compile check, no device):

    cd firmware/atoms3r-headroom
    .venv-platformio/bin/pio run -e atoms3r-m12

Flash when the M12 is in hand (per the firmware README; AtomS3R needs the
no-stub flag):

    PLATFORMIO_UPLOAD_FLAGS=--no-stub .venv-platformio/bin/pio run -e atoms3r-m12 -t upload

Then run the coexistence test plan above and confirm `vision-worker` ingests
real frames with `VISION_CAMERA_URL` set.

## Open questions / risks

- M5Unified `M5.begin` on a board with no LCD: confirm it does not block or
  crash when the display is absent (we never call `M5.Display`, but `begin`
  probes it). Likely harmless; verify on hardware.
- OV3660 fixed-focus 120° wide lens: whether small workbook text is legible is
  the core OCR-quality question (the model itself OCRs clean text perfectly —
  see the diffusiongemma probe). Test with a real workbook at reading distance;
  if poor, capture full-res on demand and/or crop.
- Exact `esp_camera` API names vary slightly by core version (`pin_sccb_sda` vs
  `pin_sscb_sda`); reconcile against the `espressif/esp32-camera` version that
  resolves under `platform = espressif32@6.7.0` at build time.

## Sources

- AtomS3R-M12 (camera pin table, sensor): https://docs.m5stack.com/en/core/AtomS3R-M12
- M5Stack ESPHome example (camera pins / XCLK 20 MHz): https://github.com/m5stack/esphome-yaml/blob/main/examples/camera/atoms3r-m12-example.yaml
- M5AtomS3 Arduino camera example (`camera_pins.h`, `esp_camera.h`): https://github.com/m5stack/M5AtomS3/blob/main/examples/Basics/camera/camera.ino
- Atomic Echo Base (signal pin table): https://docs.m5stack.com/en/atom/Atomic%20Echo%20Base
- M5Atomic-EchoBase library (ES8311 I2C/I2S GPIO): https://github.com/m5stack/M5Atomic-EchoBase
