#pragma once

#if __has_include("headroom_config.local.h")
#include "headroom_config.local.h"
#else
#include "headroom_config.example.h"
#endif

#ifndef HEADROOM_ASR_LANGUAGE
#define HEADROOM_ASR_LANGUAGE "ja"
#endif

// mDNS hostname of the PC running face-app. Empty disables mDNS resolution and
// keeps the static HEADROOM_FACE_* URLs. Guarded so a pre-existing
// headroom_config.local.h that predates mDNS support still compiles.
#ifndef HEADROOM_MDNS_HOST
#define HEADROOM_MDNS_HOST ""
#endif

#ifndef HEADROOM_CONTINUOUS_VAD_ENABLED
#define HEADROOM_CONTINUOUS_VAD_ENABLED 0
#endif

// Firmware-side RMS amplitude threshold used by HeadroomContinuousVad to
// skip silent frames before WebSocket send. 0.025 is tuned for a quiet
// indoor room with the PC-side RMS backend. When the PC bridge is
// configured for Silero (MH_ATOM_VAD_BACKEND=silero), drop this to
// ~0.005 so marginal-energy frames still reach the Silero worker — that
// is where Silero's discriminative advantage matters. Floating-point
// literal so the device persists it to NVS as the same value.
#ifndef HEADROOM_VAD_FIRMWARE_RMS
#define HEADROOM_VAD_FIRMWARE_RMS 0.025f
#endif

// Audio encoding for continuous VAD audio frames sent over the Atom→PC
// WebSocket. "pcm16" (default, raw 16-bit little-endian) preserves full
// fidelity; "ima_adpcm" applies a 4:1 lossy compression that drops
// mobile-tethered bandwidth from ~160 MB/h to ~40 MB/h. Use ADPCM with
// the Silero backend outdoors.
#ifndef HEADROOM_VAD_ENCODING
#define HEADROOM_VAD_ENCODING "ima_adpcm"
#endif

// Number of trailing low-energy frames captureAndSend keeps forwarding after
// the last speech frame. Its only job is to carry the speech decay/reverb so
// ASR receives the tail of the final word; the PC bridge finalizes the
// utterance with a receive-gap timer (MH_ATOM_VAD_END_SILENCE_MS counted from
// the last frame it got), so this no longer has to exceed endSilenceMs. 8
// (~0.5 s) is plenty. A non-zero tail is what lets the firmware skip true idle
// silence (vad_firmware_rms > 0) without clipping the end of a word. NVS.
#ifndef HEADROOM_VAD_SPEECH_TAIL_FRAMES
#define HEADROOM_VAD_SPEECH_TAIL_FRAMES 8
#endif

// Delay after actual speaker playback ends before continuous VAD reopens the
// microphone side of the shared codec. Guarded for local configuration files
// created before this per-device setting existed. Runtime persistence clamps
// values to 200..5000 ms.
#ifndef HEADROOM_VAD_PLAYBACK_COOLDOWN_MS
#define HEADROOM_VAD_PLAYBACK_COOLDOWN_MS 1200
#endif

// Safe speaker volume (0..200). Preserve the hardware-tuned
// levels that predate persistence: 112 for the faced Atom Echo Base and 200
// for the M12 Echo Base. A local config may define HEADROOM_SPEAKER_VOLUME to
// override either build.
#ifndef HEADROOM_SPEAKER_VOLUME
#ifdef HEADROOM_M12
#define HEADROOM_SPEAKER_VOLUME 200
#else
#define HEADROOM_SPEAKER_VOLUME 112
#endif
#endif

// Wi-Fi slots 2/3 are optional. Guard them so a pre-existing
// headroom_config.local.h that predates multi-AP support still compiles.
#ifndef HEADROOM_WIFI_SSID2
#define HEADROOM_WIFI_SSID2 ""
#endif
#ifndef HEADROOM_WIFI_PASSWORD2
#define HEADROOM_WIFI_PASSWORD2 ""
#endif
#ifndef HEADROOM_WIFI_SSID3
#define HEADROOM_WIFI_SSID3 ""
#endif
#ifndef HEADROOM_WIFI_PASSWORD3
#define HEADROOM_WIFI_PASSWORD3 ""
#endif
