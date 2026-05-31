#pragma once

#include <ArduinoJson.h>
#include <Arduino.h>
#include <WebSocketsClient.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_settings.h"

class HeadroomTransport {
public:
  void begin(const HeadroomSettingsData& settings, HeadroomFaceState& faceState, HeadroomAudio& audio);
  void loop();
  bool connected() const;
  bool handleJsonPayload(const uint8_t* payload, size_t length);
  bool sendOperatorText(const String& text);
  // encoding: "pcm16" (raw little-endian 16-bit) or "ima_adpcm" (4:1
  // lossy). The receiver inspects the same string in the JSON envelope.
  bool sendAtomAudioFrame(const int16_t* samples, size_t sampleCount, uint32_t sampleRate, const String& language, uint32_t seq, uint32_t generation, const String& encoding);
  void setBeforeAudioPlaybackCallback(void (*callback)(void*), void* context);

private:
  WebSocketsClient ws_;
  HeadroomFaceState* faceState_ = nullptr;
  HeadroomAudio* audio_ = nullptr;
  bool connected_ = false;
  String deviceId_;
  String displayAgentId_;
  String inputTargetAgentId_;
  uint32_t priorityDisplayUntilMs_ = 0;
  uint32_t lastExpressionMs_ = 0;
  void (*beforeAudioPlaybackCallback_)(void*) = nullptr;
  void* beforeAudioPlaybackContext_ = nullptr;

  void onWsEvent(WStype_t type, uint8_t* payload, size_t length);
  void handleAudioPayload(JsonDocument& doc, const String& type);
  bool shouldApplyPayload(const String& agentId, const String& type, uint32_t nowMs);
  void handleEventPayload(const String& name);
  void handleTtsStatePayload(JsonDocument& doc);
  void updateExpressionTimeout(uint32_t nowMs);
  void setExpression(HeadroomExpression expression);
};
