#include "headroom_transport.h"

#include <ArduinoJson.h>
#include <mbedtls/base64.h>

namespace {

struct ParsedWsUrl {
  String scheme;
  String host;
  uint16_t port = 80;
  String path = "/ws";
};

String urlEncode(const String& value) {
  String encoded;
  encoded.reserve(value.length());
  const char* hex = "0123456789ABCDEF";
  for (size_t i = 0; i < value.length(); ++i) {
    uint8_t c = static_cast<uint8_t>(value.charAt(i));
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
        c == '.' || c == '~') {
      encoded += static_cast<char>(c);
    } else {
      encoded += '%';
      encoded += hex[(c >> 4) & 0x0f];
      encoded += hex[c & 0x0f];
    }
  }
  return encoded;
}

ParsedWsUrl parseWsUrl(const String& rawUrl) {
  ParsedWsUrl parsed;
  String url = rawUrl;
  int schemeEnd = url.indexOf("://");
  if (schemeEnd >= 0) {
    parsed.scheme = url.substring(0, schemeEnd);
    url = url.substring(schemeEnd + 3);
  } else {
    parsed.scheme = "ws";
  }

  int pathStart = url.indexOf('/');
  String authority = pathStart >= 0 ? url.substring(0, pathStart) : url;
  parsed.path = pathStart >= 0 ? url.substring(pathStart) : "/ws";

  int portStart = authority.lastIndexOf(':');
  if (portStart > 0) {
    parsed.host = authority.substring(0, portStart);
    int port = authority.substring(portStart + 1).toInt();
    parsed.port = port > 0 ? static_cast<uint16_t>(port) : 80;
  } else {
    parsed.host = authority;
    parsed.port = parsed.scheme == "wss" ? 443 : 80;
  }

  if (parsed.path.length() == 0) {
    parsed.path = "/ws";
  }
  return parsed;
}

String appendQueryToken(String path, const String& token) {
  if (token.length() == 0) {
    return path;
  }
  path += path.indexOf('?') >= 0 ? '&' : '?';
  path += "auth_token=";
  path += urlEncode(token);
  return path;
}

String websocketOrigin(const ParsedWsUrl& url) {
  String origin = url.scheme == "wss" ? F("https://") : F("http://");
  origin += url.host;
  if ((url.scheme == "wss" && url.port != 443) || (url.scheme != "wss" && url.port != 80)) {
    origin += ':';
    origin += String(url.port);
  }
  return origin;
}

String stringField(JsonDocument& doc, const char* key) {
  const char* value = doc[key] | "";
  return String(value);
}

}  // namespace

void HeadroomTransport::begin(const HeadroomSettingsData& settings, HeadroomFaceState& faceState, HeadroomAudio& audio) {
  faceState_ = &faceState;
  audio_ = &audio;
  deviceId_ = settings.deviceId;
  displayAgentId_ = settings.displayAgentId;
  inputTargetAgentId_ = settings.inputTargetAgentId;

  ParsedWsUrl url = parseWsUrl(settings.faceWsUrl);
  String path = appendQueryToken(url.path, settings.authToken);
  Serial.printf("ws connecting host=%s port=%u path=%s\n", url.host.c_str(), url.port, path.c_str());

  ws_.onEvent([this](WStype_t type, uint8_t* payload, size_t length) { onWsEvent(type, payload, length); });
  String originHeader = F("Origin: ");
  originHeader += websocketOrigin(url);
  ws_.setExtraHeaders(originHeader.c_str());
  ws_.setReconnectInterval(15000);
  ws_.enableHeartbeat(15000, 3000, 2);

  if (url.scheme == "wss") {
    Serial.println("wss is not implemented yet; use ws:// on same LAN for now");
    setExpression(HeadroomExpression::Failed);
    return;
  }

  ws_.begin(url.host.c_str(), url.port, path.c_str());
}

void HeadroomTransport::loop() {
  ws_.loop();
  updateExpressionTimeout(millis());
}

bool HeadroomTransport::connected() const {
  return connected_;
}

bool HeadroomTransport::sendOperatorText(const String& text) {
  String trimmed = text;
  trimmed.trim();
  if (!connected_ || trimmed.length() == 0) {
    return false;
  }

  JsonDocument doc;
  doc["v"] = 1;
  doc["type"] = "operator_response";
  doc["session_id"] = deviceId_.length() > 0 ? deviceId_ : "atom-headroom";
  doc["request_id"] = nullptr;
  doc["response_kind"] = "text";
  doc["value"] = trimmed;
  doc["source"] = "atom";
  if (inputTargetAgentId_.length() > 0) {
    doc["target_agent_id"] = inputTargetAgentId_;
  }
  doc["ts"] = millis();

  String payload;
  serializeJson(doc, payload);
  bool ok = ws_.sendTXT(payload);
  Serial.printf("operator_response send %s bytes=%u\n", ok ? "ok" : "failed", static_cast<unsigned>(payload.length()));
  return ok;
}

bool HeadroomTransport::sendAtomAudioFrame(const int16_t* samples, size_t sampleCount, uint32_t sampleRate, const String& language, uint32_t seq, uint32_t generation) {
  if (!connected_ || !samples || sampleCount == 0) {
    return false;
  }
  const uint8_t* raw = reinterpret_cast<const uint8_t*>(samples);
  size_t rawBytes = sampleCount * sizeof(int16_t);
  size_t b64Capacity = ((rawBytes + 2) / 3) * 4 + 1;
  char* b64 = static_cast<char*>(malloc(b64Capacity));
  if (!b64) {
    return false;
  }
  size_t b64Length = 0;
  int rc = mbedtls_base64_encode(reinterpret_cast<unsigned char*>(b64), b64Capacity, &b64Length, raw, rawBytes);
  if (rc != 0) {
    free(b64);
    return false;
  }
  b64[b64Length] = '\0';

  String id = deviceId_.length() > 0 ? deviceId_ : String("atom-headroom");
  String payload;
  payload.reserve(b64Length + 220);
  payload += F("{\"v\":1,\"type\":\"atom_audio_frame\",\"session_id\":\"");
  payload += id;
  payload += F("\",\"device_id\":\"");
  payload += id;
  payload += F("\",\"language\":\"");
  payload += language == "en" ? "en" : "ja";
  payload += F("\",\"sample_rate\":");
  payload += String(sampleRate);
  payload += F(",\"seq\":");
  payload += String(seq);
  payload += F(",\"generation\":");
  payload += String(generation);
  payload += F(",\"audio_base64\":\"");
  payload += b64;
  payload += F("\"}");
  free(b64);

  return ws_.sendTXT(payload);
}

void HeadroomTransport::setBeforeAudioPlaybackCallback(void (*callback)(void*), void* context) {
  beforeAudioPlaybackCallback_ = callback;
  beforeAudioPlaybackContext_ = context;
}

void HeadroomTransport::onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      connected_ = true;
      if (faceState_) {
        faceState_->connected = true;
      }
      Serial.println("ws connected");
      setExpression(HeadroomExpression::Neutral);
      break;
    case WStype_DISCONNECTED:
      connected_ = false;
      if (faceState_) {
        faceState_->connected = false;
      }
      Serial.println("ws disconnected");
      break;
    case WStype_TEXT:
      handleJsonPayload(payload, length);
      break;
    case WStype_ERROR:
      Serial.println("ws error");
      setExpression(HeadroomExpression::Failed);
      break;
    default:
      break;
  }
}

bool HeadroomTransport::handleJsonPayload(const uint8_t* payload, size_t length) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.printf("json parse failed: %s\n", error.c_str());
    return false;
  }

  String type = stringField(doc, "type");
  String agentId = stringField(doc, "agent_id");
  if (!shouldApplyPayload(agentId, type, millis())) {
    return true;
  }

  if (type == "event") {
    handleEventPayload(stringField(doc, "name"));
  } else if (type == "tts_state") {
    handleTtsStatePayload(doc);
  } else if (type == "tts_mouth") {
    if (!faceState_) {
      return true;
    }
    float open = doc["open"] | 0.0f;
    faceState_->mouthOpen = constrain(open, 0.0f, 1.0f);
    if (faceState_->mouthOpen > 0.04f) {
      setExpression(HeadroomExpression::Speaking);
    }
  } else if (type == "tts_audio" || type == "tts_audio_ref") {
    handleAudioPayload(doc, type);
  }
  return true;
}

void HeadroomTransport::handleAudioPayload(JsonDocument& doc, const String& type) {
  if (!audio_) {
    return;
  }

  if (beforeAudioPlaybackCallback_) {
    beforeAudioPlaybackCallback_(beforeAudioPlaybackContext_);
  }

  HeadroomAudioResult result = HeadroomAudioResult::Ignored;
  if (type == "tts_audio") {
    const char* audioBase64 = doc["audio_base64"] | "";
    size_t length = strlen(audioBase64);
    int sampleRate = doc["sample_rate"] | 24000;
    result = audio_->playBase64Wav(audioBase64, length, sampleRate);
  } else {
    String url = stringField(doc, "url");
    result = audio_->playHttpWavRef(url);
  }

  if (result == HeadroomAudioResult::Ok) {
    setExpression(HeadroomExpression::Speaking);
    return;
  }
  if (result != HeadroomAudioResult::Ignored) {
    Serial.printf("audio playback failed result=%d type=%s\n", static_cast<int>(result), type.c_str());
    setExpression(HeadroomExpression::Failed);
  }
}

bool HeadroomTransport::shouldApplyPayload(const String& agentId, const String& type, uint32_t nowMs) {
  if (displayAgentId_.length() == 0 || agentId.length() == 0) {
    return true;
  }

  if (agentId == displayAgentId_) {
    if (type == "tts_mouth" || type == "tts_state" || type == "event") {
      priorityDisplayUntilMs_ = nowMs + 2500;
    }
    return true;
  }

  if (nowMs < priorityDisplayUntilMs_) {
    return false;
  }
  return true;
}

void HeadroomTransport::handleEventPayload(const String& name) {
  if (name == "cmd_started" || name == "retrying") {
    setExpression(HeadroomExpression::Thinking);
  } else if (name == "permission_required") {
    setExpression(HeadroomExpression::Permission);
  } else if (name == "cmd_failed" || name == "tests_failed") {
    setExpression(HeadroomExpression::Failed);
  } else if (name == "cmd_succeeded" || name == "tests_passed") {
    setExpression(HeadroomExpression::Success);
  } else if (name == "idle" || name == "idle_after_response") {
    if (faceState_) {
      faceState_->mouthOpen = 0.0f;
    }
    setExpression(HeadroomExpression::Neutral);
  }
}

void HeadroomTransport::handleTtsStatePayload(JsonDocument& doc) {
  String phase = stringField(doc, "phase");
  String reason = stringField(doc, "reason");

  if (phase == "interrupt_requested" || (phase == "play_stop" && reason == "interrupted")) {
    if (audio_) {
      audio_->stop();
    }
    if (faceState_) {
      faceState_->mouthOpen = 0.0f;
    }
    setExpression(HeadroomExpression::Neutral);
    return;
  }

  if (phase == "queued" || phase == "synth_start") {
    setExpression(HeadroomExpression::Thinking);
  } else if (phase == "play_start") {
    setExpression(HeadroomExpression::Speaking);
  } else if (phase == "play_stop") {
    if (audio_ && audio_->busy()) {
      setExpression(HeadroomExpression::Speaking);
      return;
    }
    if (faceState_) {
      faceState_->mouthOpen = 0.0f;
    }
    setExpression(HeadroomExpression::Neutral);
  } else if (phase == "dropped" || phase == "worker_error") {
    setExpression(HeadroomExpression::Failed);
  }
}

void HeadroomTransport::updateExpressionTimeout(uint32_t nowMs) {
  if (!faceState_ || lastExpressionMs_ == 0) {
    return;
  }

  if (faceState_->expression == HeadroomExpression::Speaking) {
    if ((!audio_ || !audio_->busy()) && faceState_->mouthOpen <= 0.04f && nowMs - lastExpressionMs_ > 2500) {
      setExpression(HeadroomExpression::Neutral);
    }
    return;
  }

  // Failed (like Permission) is intentionally NOT auto-reverted: the red
  // background must persist until the next state event (idle / cmd_* /
  // tts_state) so a transient error is not visually lost after 8 s.
  if (faceState_->expression == HeadroomExpression::Thinking ||
      faceState_->expression == HeadroomExpression::Success) {
    if (nowMs - lastExpressionMs_ > 8000) {
      faceState_->mouthOpen = 0.0f;
      setExpression(HeadroomExpression::Neutral);
    }
  }
}

void HeadroomTransport::setExpression(HeadroomExpression expression) {
  if (!faceState_) {
    return;
  }
  faceState_->expression = expression;
  lastExpressionMs_ = millis();
}
