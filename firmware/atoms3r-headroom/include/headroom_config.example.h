#pragma once

#define HEADROOM_WIFI_SSID "your-wifi"
#define HEADROOM_WIFI_PASSWORD "your-password"

// Optional secondary/tertiary Wi-Fi networks. Empty means "slot unused".
// At boot the firmware tries slot 1, then 2, then 3, in that order.
#define HEADROOM_WIFI_SSID2 ""
#define HEADROOM_WIFI_PASSWORD2 ""
#define HEADROOM_WIFI_SSID3 ""
#define HEADROOM_WIFI_PASSWORD3 ""
#define HEADROOM_FACE_HTTP_BASE "http://192.168.1.10:8765"
#define HEADROOM_FACE_WS_URL "ws://192.168.1.10:8765/ws"
// Optional mDNS hostname of the PC running face-app (e.g. "my-pc.local"). When
// non-empty, the device resolves it at boot and rewrites the host in BOTH the
// WebSocket and HTTP base URLs above to the PC's current LAN IP, so a DHCP
// address change no longer needs re-provisioning. Empty disables mDNS (the
// static URLs are used verbatim). mDNS does not cross subnets — keep the static
// URLs pointed at a stable off-LAN address (e.g. a Tailscale IP) so the device
// still reaches the PC when mDNS can't resolve (the resolve failure falls back
// to the static URLs).
#define HEADROOM_MDNS_HOST ""
#define HEADROOM_FACE_AUTH_TOKEN ""
#define HEADROOM_DEVICE_ID "atom-headroom-1"
#define HEADROOM_DISPLAY_AGENT_ID "__operator__"
#define HEADROOM_INPUT_TARGET_AGENT_ID "__operator__"
#define HEADROOM_ASR_LANGUAGE "ja"
#define HEADROOM_CONTINUOUS_VAD_ENABLED 0
// Firmware-side speech threshold used by continuous VAD to drop silent
// frames before sending. 0.025 fits the PC-side RMS backend on a quiet
// room. Set to ~0.005 if the PC bridge uses Silero so Silero can see
// marginal-energy frames.
#define HEADROOM_VAD_FIRMWARE_RMS 0.025f
// "pcm16" (raw 16-bit) or "ima_adpcm" (4:1 lossy for mobile use).
#define HEADROOM_VAD_ENCODING "pcm16"
// Trailing silence frames sent after speech (0..240; 8 ≈ 0.5 s). Just carries
// the speech decay for ASR — the PC bridge's receive-gap timer finalizes the
// utterance, so the tail no longer needs to exceed MH_ATOM_VAD_END_SILENCE_MS.
#define HEADROOM_VAD_SPEECH_TAIL_FRAMES 8
#define HEADROOM_MAX_BASE64_TTS_SECONDS 15
#define HEADROOM_MAX_HTTP_TTS_BYTES 1200000

// Valid face rotations are 0, 90, 180, and 270 degrees.
#define HEADROOM_FACE_ROTATION_DEGREES 0

// Initial supported placement poses are "screen_up" and "side_up".
#define HEADROOM_PLACEMENT_POSE "screen_up"
#define HEADROOM_UP_SIDE_DEGREES 0
