#pragma once

#include <Arduino.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_settings.h"
#include "headroom_transport.h"

enum class HeadroomPttState {
  Idle,
  Recording,
  Processing,
  Error,
};

class HeadroomPtt {
public:
  void begin(const HeadroomSettingsData& settings, HeadroomAudio& audio, HeadroomTransport& transport, HeadroomFaceState& faceState);
  void update();
  bool recording() const;
  HeadroomPttState state() const;

private:
  static constexpr uint32_t kSampleRate = 16000;
  static constexpr size_t kMaxSeconds = 8;
  static constexpr size_t kMaxSamples = kSampleRate * kMaxSeconds;
  static constexpr size_t kChunkSamples = 1024;
  static constexpr size_t kWavHeaderBytes = 44;
  // Hold this long before recording arms, so a short tap (or a triple-tap
  // rotate gesture) never opens the mic. The arming "ピッ" cue plays right
  // after this threshold; the user speaks after the beep.
  static constexpr uint32_t kArmMs = 500;

  HeadroomAudio* audio_ = nullptr;
  HeadroomTransport* transport_ = nullptr;
  HeadroomFaceState* faceState_ = nullptr;
  String httpBase_;
  String authToken_;
  String deviceId_;
  String inputTargetAgentId_;
  String asrLanguage_ = "ja";
  int16_t* pcm_ = nullptr;
  size_t samplesRecorded_ = 0;
  HeadroomPttState state_ = HeadroomPttState::Idle;
  uint32_t stateSinceMs_ = 0;
  bool pressedLast_ = false;
  uint32_t pressStartMs_ = 0;

  bool startRecording();
  void captureChunk();
  void finishRecording();
  void resetRecording();
  bool postToAsrAndSubmit();
  bool submitOperatorText(const String& text);
  bool buildWav(uint8_t** outWav, size_t* outLength) const;
  String asrUrl() const;
  String operatorResponseUrl() const;
  void setState(HeadroomPttState next);
  void setFaceExpression(HeadroomExpression expression, float mouthOpen = 0.0f);
};
