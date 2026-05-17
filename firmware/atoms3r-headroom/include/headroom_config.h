#pragma once

#if __has_include("headroom_config.local.h")
#include "headroom_config.local.h"
#else
#include "headroom_config.example.h"
#endif

#ifndef HEADROOM_ASR_LANGUAGE
#define HEADROOM_ASR_LANGUAGE "ja"
#endif
