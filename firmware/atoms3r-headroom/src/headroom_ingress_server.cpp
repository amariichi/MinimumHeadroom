#include "headroom_ingress_server.h"

#include <WiFi.h>

namespace {

constexpr size_t kMinimumPayloadBytes = 32768;
constexpr size_t kMaximumPayloadBytes = 1100 * 1024;

bool timingSafeStringEquals(const String& left, const String& right) {
  if (left.length() != right.length()) {
    return false;
  }
  uint8_t diff = 0;
  for (size_t i = 0; i < left.length(); ++i) {
    diff |= static_cast<uint8_t>(left.charAt(i)) ^ static_cast<uint8_t>(right.charAt(i));
  }
  return diff == 0;
}

String bearerToken(const String& authorization) {
  if (!authorization.startsWith("Bearer ")) {
    return String();
  }
  String token = authorization.substring(7);
  token.trim();
  return token;
}

size_t estimatePayloadLimit(const HeadroomSettingsData& settings) {
  size_t decodedBytes = static_cast<size_t>(max(1, min(15, settings.maxBase64TtsSeconds))) * 24000 * 2 + 128;
  size_t jsonBytes = ((decodedBytes + 2) / 3) * 4 + 16384;
  return min(kMaximumPayloadBytes, max(kMinimumPayloadBytes, jsonBytes));
}

String jsonEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    char c = value.charAt(i);
    switch (c) {
      case '"':
        escaped += F("\\\"");
        break;
      case '\\':
        escaped += F("\\\\");
        break;
      case '\n':
        escaped += F("\\n");
        break;
      case '\r':
        escaped += F("\\r");
        break;
      case '\t':
        escaped += F("\\t");
        break;
      default:
        if (static_cast<uint8_t>(c) < 0x20) {
          escaped += ' ';
        } else {
          escaped += c;
        }
        break;
    }
  }
  return escaped;
}

}  // namespace

void HeadroomIngressServer::begin(const HeadroomSettingsData& settings, HeadroomTransport& transport, HeadroomAudio& audio,
                                  HeadroomFaceState& faceState) {
  transport_ = &transport;
  audio_ = &audio;
  faceState_ = &faceState;
  faceHttpBase_ = settings.faceHttpBase;
  faceWsUrl_ = settings.faceWsUrl;
  authToken_ = settings.authToken;
  deviceId_ = settings.deviceId;
  asrLanguage_ = settings.asrLanguage;
  continuousVadEnabled_ = settings.continuousVadEnabled;
  maxPayloadBytes_ = estimatePayloadLimit(settings);

  const char* headerKeys[] = {"Authorization", "X-Headroom-Auth"};
  server_.collectHeaders(headerKeys, 2);
  server_.on("/health", HTTP_GET, [this]() { handleHealth(); });
  server_.on("/api/headroom/payload", HTTP_OPTIONS, [this]() { handleOptions(); });
  server_.on("/api/headroom/payload", HTTP_POST, [this]() { handlePayload(); });
  server_.on("/api/headroom/audio", HTTP_OPTIONS, [this]() { handleOptions(); });
  server_.on("/api/headroom/audio", HTTP_POST, [this]() { handleAudio(); }, [this]() { handleAudioRaw(); });
  server_.onNotFound([this]() { handleNotFound(); });
  server_.begin();
  active_ = true;

  Serial.printf("ingress listening http://%s/ max_payload=%u\n", WiFi.localIP().toString().c_str(),
                static_cast<unsigned>(maxPayloadBytes_));
}

void HeadroomIngressServer::loop() {
  if (!active_) {
    return;
  }
  server_.handleClient();
}

bool HeadroomIngressServer::active() const {
  return active_;
}

bool HeadroomIngressServer::recentlyActive(uint32_t windowMs) const {
  return lastPayloadMs_ != 0 && millis() - lastPayloadMs_ <= windowMs;
}

void HeadroomIngressServer::setContinuousVadEnabled(bool enabled) {
  continuousVadEnabled_ = enabled;
}

void HeadroomIngressServer::setBeforeAudioPlaybackCallback(void (*callback)(void*), void* context) {
  beforeAudioPlaybackCallback_ = callback;
  beforeAudioPlaybackContext_ = context;
}

void HeadroomIngressServer::handleHealth() {
  String body = F("{\"ok\":true,\"service\":\"atoms3r-headroom\",\"device_id\":\"");
  body += jsonEscape(deviceId_);
  body += F("\",\"ip\":\"");
  body += WiFi.localIP().toString();
  body += F("\",\"ingress\":true,\"ws_connected\":");
  body += transport_ && transport_->connected() ? F("true") : F("false");
  body += F(",\"face_http_base\":\"");
  body += jsonEscape(faceHttpBase_);
  body += F("\",\"face_ws_url\":\"");
  body += jsonEscape(faceWsUrl_);
  body += F("\",\"auth_configured\":");
  body += authToken_.length() > 0 ? F("true") : F("false");
  body += F(",\"asr_language\":\"");
  body += jsonEscape(asrLanguage_);
  body += F("\",\"continuous_vad_enabled\":");
  body += continuousVadEnabled_ ? F("true") : F("false");
  body += F("}");
  sendJson(200, body);
}

void HeadroomIngressServer::handlePayload() {
  if (!isAuthorized()) {
    sendJson(401, F("{\"ok\":false,\"error\":\"unauthorized\"}"));
    return;
  }
  if (!transport_) {
    sendJson(503, F("{\"ok\":false,\"error\":\"transport_not_ready\"}"));
    return;
  }

  String body = server_.arg("plain");
  if (body.length() == 0) {
    sendJson(400, F("{\"ok\":false,\"error\":\"empty_body\"}"));
    return;
  }
  if (body.length() > maxPayloadBytes_) {
    sendJson(413, F("{\"ok\":false,\"error\":\"payload_too_large\"}"));
    return;
  }

  bool ok = transport_->handleJsonPayload(reinterpret_cast<const uint8_t*>(body.c_str()), body.length());
  if (!ok) {
    sendJson(400, F("{\"ok\":false,\"error\":\"invalid_json\"}"));
    return;
  }

  lastPayloadMs_ = millis();
  sendJson(202, F("{\"ok\":true}"));
}

void HeadroomIngressServer::handleAudioRaw() {
  HTTPRaw& raw = server_.raw();

  if (raw.status == RAW_START) {
    releaseAudioRawBuffer();
    audioRawUnauthorized_ = false;
    audioRawTooLarge_ = false;
    audioRawFailed_ = false;

    if (!isAuthorized()) {
      audioRawUnauthorized_ = true;
      return;
    }

    int contentLength = server_.clientContentLength();
    if (contentLength <= 0) {
      audioRawFailed_ = true;
      return;
    }
    if (static_cast<size_t>(contentLength) > maxPayloadBytes_) {
      audioRawTooLarge_ = true;
      return;
    }

    audioRawCapacity_ = static_cast<size_t>(contentLength);
    audioRawBuffer_ = static_cast<uint8_t*>(ps_malloc(audioRawCapacity_));
    if (!audioRawBuffer_) {
      audioRawBuffer_ = static_cast<uint8_t*>(malloc(audioRawCapacity_));
    }
    if (!audioRawBuffer_) {
      audioRawCapacity_ = 0;
      audioRawFailed_ = true;
    }
    return;
  }

  if (raw.status == RAW_WRITE) {
    if (audioRawUnauthorized_ || audioRawTooLarge_ || audioRawFailed_) {
      return;
    }
    if (!audioRawBuffer_ || audioRawLength_ + raw.currentSize > audioRawCapacity_) {
      audioRawTooLarge_ = true;
      releaseAudioRawBuffer();
      return;
    }
    memcpy(audioRawBuffer_ + audioRawLength_, raw.buf, raw.currentSize);
    audioRawLength_ += raw.currentSize;
    return;
  }

  if (raw.status == RAW_ABORTED) {
    audioRawFailed_ = true;
    releaseAudioRawBuffer();
  }
}

void HeadroomIngressServer::handleAudio() {
  if (!isAuthorized()) {
    sendJson(401, F("{\"ok\":false,\"error\":\"unauthorized\"}"));
    return;
  }
  if (!audio_ || !faceState_) {
    sendJson(503, F("{\"ok\":false,\"error\":\"audio_not_ready\"}"));
    return;
  }

  if (audioRawUnauthorized_) {
    sendJson(401, F("{\"ok\":false,\"error\":\"unauthorized\"}"));
    return;
  }
  if (audioRawTooLarge_) {
    releaseAudioRawBuffer();
    sendJson(413, F("{\"ok\":false,\"error\":\"payload_too_large\"}"));
    return;
  }
  if (audioRawFailed_) {
    releaseAudioRawBuffer();
    sendJson(400, F("{\"ok\":false,\"error\":\"audio_body_failed\"}"));
    return;
  }
  if (!audioRawBuffer_ || audioRawLength_ == 0) {
    sendJson(400, F("{\"ok\":false,\"error\":\"empty_body\"}"));
    return;
  }

  if (beforeAudioPlaybackCallback_) {
    beforeAudioPlaybackCallback_(beforeAudioPlaybackContext_);
  }

  HeadroomAudioResult result = audio_->playWavBytes(audioRawBuffer_, audioRawLength_);
  size_t audioBytes = audioRawLength_;
  releaseAudioRawBuffer();
  if (result == HeadroomAudioResult::Ignored) {
    // Benign skip (e.g. PTT mic window): ack without flashing the Failed
    // face. The dropped chunk's mouth still rides the tts_mouth stream.
    sendJson(202, F("{\"ok\":true,\"skipped\":true}"));
    return;
  }
  if (result != HeadroomAudioResult::Ok) {
    Serial.printf("ingress audio failed result=%d bytes=%u\n", static_cast<int>(result), static_cast<unsigned>(audioBytes));
    faceState_->expression = HeadroomExpression::Failed;
    String body = F("{\"ok\":false,\"error\":\"audio_rejected\",\"result\":");
    body += static_cast<int>(result);
    body += F("}");
    sendJson(400, body);
    return;
  }

  faceState_->expression = HeadroomExpression::Speaking;
  faceState_->mouthOpen = max(faceState_->mouthOpen, 0.28f);
  lastPayloadMs_ = millis();
  sendJson(202, F("{\"ok\":true}"));
}

void HeadroomIngressServer::handleOptions() {
  server_.sendHeader("Access-Control-Allow-Origin", "*");
  server_.sendHeader("Access-Control-Allow-Headers", "content-type,authorization,x-headroom-auth,x-utterance-id,x-generation");
  server_.sendHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  server_.send(204, "text/plain", "");
}

void HeadroomIngressServer::handleNotFound() {
  sendJson(404, F("{\"ok\":false,\"error\":\"not_found\"}"));
}

bool HeadroomIngressServer::isAuthorized() {
  if (authToken_.length() == 0) {
    return true;
  }

  String queryToken = server_.arg("auth_token");
  if (queryToken.length() == 0) {
    queryToken = server_.arg("token");
  }
  if (queryToken.length() > 0 && timingSafeStringEquals(queryToken, authToken_)) {
    return true;
  }

  String headerToken = server_.header("X-Headroom-Auth");
  if (headerToken.length() > 0 && timingSafeStringEquals(headerToken, authToken_)) {
    return true;
  }

  String bearer = bearerToken(server_.header("Authorization"));
  return bearer.length() > 0 && timingSafeStringEquals(bearer, authToken_);
}

void HeadroomIngressServer::releaseAudioRawBuffer() {
  if (audioRawBuffer_) {
    free(audioRawBuffer_);
  }
  audioRawBuffer_ = nullptr;
  audioRawLength_ = 0;
  audioRawCapacity_ = 0;
}

void HeadroomIngressServer::sendJson(int statusCode, const String& body) {
  server_.sendHeader("Cache-Control", "no-store");
  server_.sendHeader("Access-Control-Allow-Origin", "*");
  server_.send(statusCode, "application/json; charset=utf-8", body);
}
