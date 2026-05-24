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
  // Short confirmation tone (the PTT "ピッ" arming cue). MUST be called only
  // while the codec is still in DAC mode (before stopForRecording): it plays
  // and fully drains the tone synchronously, then returns, so no DAC activity
  // can leak into the mic window. No-op while recording_ is set.
  void playCueTone(uint16_t freqHz = 2000, uint32_t ms = 120);
  void stopForRecording();
  void restoreAfterRecording();
  bool busy() const;
  // 0..1 mouth openness sampled from the PCM currently being played on this
  // device. Returns 0 when nothing is playing. The 口パク must follow the
  // device's own playback clock; the PC-side tts_mouth stream is timed to the
  // worker's local playback and drifts per chunk over a long utterance.
  float currentMouthOpen();
  // True while the shared ES8311 codec is switched to mic/ADC for PTT.
  // No DAC playback may happen in this window or the codec latches into a
  // corrupted state that only a hardware power cycle clears.
  bool recording() const;

  HeadroomAudioResult playBase64Wav(const char* audioBase64, size_t base64Length, int sampleRateHint);
  HeadroomAudioResult playHttpWavRef(const String& url);
  HeadroomAudioResult playWavBytes(const uint8_t* wav, size_t length);

private:
  String httpBase_;
  String authToken_;
  int maxBase64Seconds_ = 10;
  int maxHttpBytes_ = 1200000;
  uint8_t speakerVolume_ = 112;
  uint8_t* activeWav_ = nullptr;
  size_t activeWavLength_ = 0;
  static constexpr size_t kQueuedWavCapacity = 1;  // Bound AtomS3R RAM: one active WAV plus one pending chunk.
  struct QueuedWav {
    uint8_t* data = nullptr;
    size_t length = 0;
  };
  QueuedWav queuedWavs_[kQueuedWavCapacity];
  size_t queuedWavCount_ = 0;
  bool recording_ = false;

  // Window over the in-flight PCM, captured at playRaw() time, used by
  // currentMouthOpen() to derive the envelope from real device playback.
  const int16_t* mouthPcm_ = nullptr;
  size_t mouthSampleCount_ = 0;
  int mouthSampleRate_ = 0;
  uint32_t mouthPlayStartMs_ = 0;
  // Release tail so the mouth glides shut over codec output latency and
  // inter-chunk gaps instead of snapping the instant isPlaying() drops.
  float mouthLastLevel_ = 0.0f;
  uint32_t mouthLastActiveMs_ = 0;

  void beginSpeaker();
  void resetSpeaker();
  void releaseActive();
  void releaseQueued();
  bool enqueueOwnedWav(uint8_t* wav, size_t length);
  bool popQueuedWav(QueuedWav* out);
  HeadroomAudioResult startOwnedWavNow(uint8_t* wav, size_t length, bool takeOwnership);
  HeadroomAudioResult playOwnedWav(uint8_t* wav, size_t length, bool takeOwnership);
  bool inspectWav(const uint8_t* wav, size_t length, int* sampleRate, size_t* dataOffset, size_t* dataBytes, uint16_t* bitsPerSample,
                  uint16_t* channels);
  bool pcmLooksSafe(const int16_t* samples, size_t sampleCount);
  String absoluteUrl(const String& url) const;
};
