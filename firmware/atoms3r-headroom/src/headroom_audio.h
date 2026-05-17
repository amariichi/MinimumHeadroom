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
  void stopForRecording();
  void restoreAfterRecording();
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

  // Bounded FIFO of decoded WAV chunks waiting to play. Server-side
  // sentence chunking delivers an ordered burst of small refs; without
  // this queue each newly arrived chunk would M5.Speaker.stop() and
  // truncate the one still playing. Chunks are small (the server caps
  // the text length), so a shallow queue is enough.
  static constexpr size_t kMaxQueued = 8;
  uint8_t* queued_[kMaxQueued] = {nullptr};
  size_t queuedLen_[kMaxQueued] = {0};
  size_t queueHead_ = 0;
  size_t queueCount_ = 0;

  void releaseActive();
  void clearQueue();
  bool enqueueOwned(uint8_t* wav, size_t length);
  HeadroomAudioResult playOrEnqueue(uint8_t* wav, size_t length);
  void startNextIfIdle();
  HeadroomAudioResult playOwnedWav(uint8_t* wav, size_t length, bool takeOwnership);
  bool inspectWav(const uint8_t* wav, size_t length, int* sampleRate, size_t* dataBytes, uint16_t* bitsPerSample, uint16_t* channels);
  String absoluteUrl(const String& url) const;
};
