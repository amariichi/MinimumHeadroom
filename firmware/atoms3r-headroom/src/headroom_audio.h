#pragma once

#include <Arduino.h>

#include "headroom_settings.h"

enum class HeadroomAudioResult {
  Ok,
  Ignored,
  TooLarge,
  DecodeFailed,
  HttpFailed,
  Unsupported,
  PlaybackFailed,
};

class HeadroomAudio {
public:
  void begin(const HeadroomSettingsData& settings);
  void loop();
  void stop();
  bool busy() const;

  HeadroomAudioResult playBase64Wav(const char* audioBase64, size_t base64Length, int sampleRateHint);
  HeadroomAudioResult playHttpWavRef(const String& url);
  HeadroomAudioResult playWavBytes(const uint8_t* wav, size_t length);

private:
  String httpBase_;
  String authToken_;
  int maxBase64Seconds_ = 10;
  int maxHttpBytes_ = 1200000;
  uint8_t* activeWav_ = nullptr;
  size_t activeWavLength_ = 0;

  void releaseActive();
  HeadroomAudioResult playOwnedWav(uint8_t* wav, size_t length, bool takeOwnership);
  bool inspectWav(const uint8_t* wav, size_t length, int* sampleRate, size_t* dataBytes, uint16_t* bitsPerSample, uint16_t* channels);
  String absoluteUrl(const String& url) const;
};
