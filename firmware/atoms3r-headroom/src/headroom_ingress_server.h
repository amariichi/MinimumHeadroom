#pragma once

#include <Arduino.h>
#include <WebServer.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_settings.h"
#include "headroom_transport.h"

class HeadroomIngressServer {
public:
  void begin(const HeadroomSettingsData& settings, HeadroomTransport& transport, HeadroomAudio& audio, HeadroomFaceState& faceState);
  void loop();
  bool active() const;
  bool recentlyActive(uint32_t windowMs) const;
  void setContinuousVadEnabled(bool enabled);
  void setBeforeAudioPlaybackCallback(void (*callback)(void*), void* context);
  // Lends the shared WebServer so optional variants (the M12 camera) can
  // register extra routes on the single server instance. Valid after begin().
  WebServer& server() { return server_; }

private:
  WebServer server_{80};
  HeadroomTransport* transport_ = nullptr;
  HeadroomAudio* audio_ = nullptr;
  HeadroomFaceState* faceState_ = nullptr;
  String faceHttpBase_;
  String faceWsUrl_;
  String mdnsHost_;
  String authToken_;
  String deviceId_;
  String asrLanguage_;
  bool continuousVadEnabled_ = false;
  float vadFirmwareRms_ = 0.025f;
  String vadEncoding_ = "pcm16";
  int vadSpeechTailFrames_ = 16;
  bool active_ = false;
  size_t maxPayloadBytes_ = 720000;
  uint32_t lastPayloadMs_ = 0;
  uint8_t* audioRawBuffer_ = nullptr;
  size_t audioRawLength_ = 0;
  size_t audioRawCapacity_ = 0;
  bool audioRawUnauthorized_ = false;
  bool audioRawTooLarge_ = false;
  bool audioRawFailed_ = false;
  void (*beforeAudioPlaybackCallback_)(void*) = nullptr;
  void* beforeAudioPlaybackContext_ = nullptr;

  void handleHealth();
  void handlePayload();
  void handleAudioRaw();
  void handleAudio();
  void handleOptions();
  void handleNotFound();
  bool isAuthorized();
  void releaseAudioRawBuffer();
  void sendJson(int statusCode, const String& body);
};
