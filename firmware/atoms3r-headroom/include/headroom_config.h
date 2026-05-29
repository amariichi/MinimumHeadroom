#pragma once

#if __has_include("headroom_config.local.h")
#include "headroom_config.local.h"
#else
#include "headroom_config.example.h"
#endif

#ifndef HEADROOM_ASR_LANGUAGE
#define HEADROOM_ASR_LANGUAGE "ja"
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
#define HEADROOM_VAD_ENCODING "pcm16"
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
