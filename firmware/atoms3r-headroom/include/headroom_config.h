#pragma once

#if __has_include("headroom_config.local.h")
#include "headroom_config.local.h"
#else
#include "headroom_config.example.h"
#endif

#ifndef HEADROOM_ASR_LANGUAGE
#define HEADROOM_ASR_LANGUAGE "ja"
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
