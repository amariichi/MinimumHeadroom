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
#define HEADROOM_FACE_AUTH_TOKEN ""
#define HEADROOM_DEVICE_ID "atom-headroom-1"
#define HEADROOM_DISPLAY_AGENT_ID "__operator__"
#define HEADROOM_INPUT_TARGET_AGENT_ID "__operator__"
#define HEADROOM_ASR_LANGUAGE "ja"
#define HEADROOM_CONTINUOUS_VAD_ENABLED 0
#define HEADROOM_MAX_BASE64_TTS_SECONDS 15
#define HEADROOM_MAX_HTTP_TTS_BYTES 1200000

// Valid face rotations are 0, 90, 180, and 270 degrees.
#define HEADROOM_FACE_ROTATION_DEGREES 0

// Initial supported placement poses are "screen_up" and "side_up".
#define HEADROOM_PLACEMENT_POSE "screen_up"
#define HEADROOM_UP_SIDE_DEGREES 0
