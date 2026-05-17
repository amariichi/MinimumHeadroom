#include "headroom_ptt.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <M5Unified.h>
#include <WiFiClient.h>
#include <string.h>

namespace {

void writeLe16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value & 0xff);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void writeLe32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value & 0xff);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  out[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  out[3] = static_cast<uint8_t>((value >> 24) & 0xff);
}

bool isHttpUrl(const String& url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

constexpr uint16_t kAsrHttpTimeoutMs = 30000;
constexpr uint16_t kOperatorResponseHttpTimeoutMs = 8000;

}  // namespace

void HeadroomPtt::begin(
    const HeadroomSettingsData& settings,
    HeadroomAudio& audio,
    HeadroomTransport& transport,
    HeadroomFaceState& faceState) {
  audio_ = &audio;
  transport_ = &transport;
  faceState_ = &faceState;
  httpBase_ = settings.faceHttpBase;
  authToken_ = settings.authToken;
  deviceId_ = settings.deviceId;
  inputTargetAgentId_ = settings.inputTargetAgentId;
  asrLanguage_ = HeadroomSettings::normalizeAsrLanguage(settings.asrLanguage);
  Serial.printf("ptt ready asr_lang=%s mic_enabled=%s\n", asrLanguage_.c_str(), M5.Mic.isEnabled() ? "yes" : "no");
}

void HeadroomPtt::update() {
  bool pressed = M5.BtnA.isPressed();

  if (state_ == HeadroomPttState::Idle && pressed && !pressedLast_) {
    startRecording();
  }

  if (state_ == HeadroomPttState::Recording) {
    if (pressed && samplesRecorded_ < kMaxSamples) {
      captureChunk();
    }
    if (!pressed || samplesRecorded_ >= kMaxSamples) {
      finishRecording();
    }
  }

  if (state_ == HeadroomPttState::Error && millis() - stateSinceMs_ > 2500) {
    setState(HeadroomPttState::Idle);
    setFaceExpression(HeadroomExpression::Neutral);
  }

  pressedLast_ = pressed;
}

bool HeadroomPtt::recording() const {
  return state_ == HeadroomPttState::Recording;
}

HeadroomPttState HeadroomPtt::state() const {
  return state_;
}

bool HeadroomPtt::startRecording() {
  if (!audio_ || !transport_ || !faceState_) {
    return false;
  }
  if (audio_->busy()) {
    audio_->stopForRecording();
  } else {
    audio_->stopForRecording();
  }

  resetRecording();
  pcm_ = static_cast<int16_t*>(ps_malloc(kMaxSamples * sizeof(int16_t)));
  if (!pcm_) {
    pcm_ = static_cast<int16_t*>(malloc(kMaxSamples * sizeof(int16_t)));
  }
  if (!pcm_) {
    Serial.println("ptt alloc failed");
    audio_->restoreAfterRecording();
    setState(HeadroomPttState::Error);
    setFaceExpression(HeadroomExpression::Failed);
    return false;
  }

  if (!M5.Mic.begin()) {
    Serial.println("M5.Mic.begin failed");
    resetRecording();
    audio_->restoreAfterRecording();
    setState(HeadroomPttState::Error);
    setFaceExpression(HeadroomExpression::Failed);
    return false;
  }

  samplesRecorded_ = 0;
  setState(HeadroomPttState::Recording);
  setFaceExpression(HeadroomExpression::Listening, 0.08f);
  Serial.println("ptt recording started");
  return true;
}

void HeadroomPtt::captureChunk() {
  if (!pcm_ || samplesRecorded_ >= kMaxSamples) {
    return;
  }
  size_t remaining = kMaxSamples - samplesRecorded_;
  size_t chunkSamples = min(remaining, kChunkSamples);
  int16_t* dest = pcm_ + samplesRecorded_;
  if (!M5.Mic.record(dest, chunkSamples, kSampleRate, false)) {
    Serial.println("M5.Mic.record failed");
    return;
  }
  uint32_t waitStarted = millis();
  while (!M5.Mic.isRecording() && millis() - waitStarted < 20) {
    delay(1);
    M5.update();
  }
  while (M5.Mic.isRecording()) {
    delay(1);
    M5.update();
  }
  samplesRecorded_ += chunkSamples;
  if (faceState_) {
    faceState_->mouthOpen = 0.10f + 0.20f * static_cast<float>((samplesRecorded_ / kChunkSamples) % 3) / 2.0f;
  }
}

void HeadroomPtt::finishRecording() {
  setState(HeadroomPttState::Processing);
  setFaceExpression(HeadroomExpression::Thinking, 0.0f);
  M5.Mic.end();
  audio_->restoreAfterRecording();

  Serial.printf("ptt recording finished samples=%u\n", static_cast<unsigned>(samplesRecorded_));
  if (samplesRecorded_ < (kSampleRate / 4)) {
    Serial.println("ptt recording too short");
    resetRecording();
    setState(HeadroomPttState::Error);
    setFaceExpression(HeadroomExpression::Failed);
    return;
  }

  bool ok = postToAsrAndSubmit();
  resetRecording();
  if (ok) {
    setState(HeadroomPttState::Idle);
    setFaceExpression(HeadroomExpression::Success);
  } else {
    setState(HeadroomPttState::Error);
    setFaceExpression(HeadroomExpression::Failed);
  }
}

void HeadroomPtt::resetRecording() {
  if (pcm_) {
    free(pcm_);
    pcm_ = nullptr;
  }
  samplesRecorded_ = 0;
}

bool HeadroomPtt::postToAsrAndSubmit() {
  uint8_t* wav = nullptr;
  size_t wavLength = 0;
  if (!buildWav(&wav, &wavLength)) {
    return false;
  }

  String url = asrUrl();
  if (!isHttpUrl(url)) {
    Serial.printf("invalid ASR URL: %s\n", url.c_str());
    free(wav);
    return false;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    free(wav);
    return false;
  }
  http.setTimeout(kAsrHttpTimeoutMs);
  http.addHeader("Content-Type", "audio/wav");
  if (authToken_.length() > 0) {
    http.addHeader("Authorization", String("Bearer ") + authToken_);
  }

  Serial.printf("posting ASR wav bytes=%u url=%s\n", static_cast<unsigned>(wavLength), url.c_str());
  int status = http.POST(wav, wavLength);
  free(wav);

  if (status != HTTP_CODE_OK) {
    String body = http.getString();
    Serial.printf("ASR POST failed status=%d body=%s\n", status, body.substring(0, 160).c_str());
    http.end();
    return false;
  }

  String body = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, body);
  if (error) {
    Serial.printf("ASR JSON parse failed: %s\n", error.c_str());
    return false;
  }

  const char* textValue = doc["text"] | "";
  String text(textValue);
  text.trim();
  if (text.length() == 0) {
    Serial.println("ASR returned empty text");
    return false;
  }

  Serial.printf("ASR text: %s\n", text.c_str());
  return submitOperatorText(text);
}

bool HeadroomPtt::submitOperatorText(const String& text) {
  String trimmed = text;
  trimmed.trim();
  if (trimmed.length() == 0) {
    return false;
  }

  if (transport_ && transport_->sendOperatorText(trimmed)) {
    return true;
  }

  String url = operatorResponseUrl();
  if (!isHttpUrl(url)) {
    Serial.printf("invalid operator response URL: %s\n", url.c_str());
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

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, url)) {
    return false;
  }
  http.setTimeout(kOperatorResponseHttpTimeoutMs);
  http.addHeader("Content-Type", "application/json");
  if (authToken_.length() > 0) {
    http.addHeader("Authorization", String("Bearer ") + authToken_);
  }

  Serial.printf("posting operator_response bytes=%u url=%s\n", static_cast<unsigned>(payload.length()), url.c_str());
  int status = http.POST(const_cast<uint8_t*>(reinterpret_cast<const uint8_t*>(payload.c_str())), payload.length());
  String body = http.getString();
  http.end();
  if (status != HTTP_CODE_OK && status != HTTP_CODE_ACCEPTED) {
    Serial.printf("operator_response HTTP failed status=%d body=%s\n", status, body.substring(0, 160).c_str());
    return false;
  }
  Serial.printf("operator_response HTTP ok status=%d\n", status);
  return true;
}

bool HeadroomPtt::buildWav(uint8_t** outWav, size_t* outLength) const {
  if (!pcm_ || samplesRecorded_ == 0 || !outWav || !outLength) {
    return false;
  }
  size_t dataBytes = samplesRecorded_ * sizeof(int16_t);
  size_t totalBytes = kWavHeaderBytes + dataBytes;
  uint8_t* wav = static_cast<uint8_t*>(ps_malloc(totalBytes));
  if (!wav) {
    wav = static_cast<uint8_t*>(malloc(totalBytes));
  }
  if (!wav) {
    return false;
  }

  memcpy(wav, "RIFF", 4);
  writeLe32(wav + 4, static_cast<uint32_t>(totalBytes - 8));
  memcpy(wav + 8, "WAVE", 4);
  memcpy(wav + 12, "fmt ", 4);
  writeLe32(wav + 16, 16);
  writeLe16(wav + 20, 1);
  writeLe16(wav + 22, 1);
  writeLe32(wav + 24, kSampleRate);
  writeLe32(wav + 28, kSampleRate * 2);
  writeLe16(wav + 32, 2);
  writeLe16(wav + 34, 16);
  memcpy(wav + 36, "data", 4);
  writeLe32(wav + 40, static_cast<uint32_t>(dataBytes));
  memcpy(wav + kWavHeaderBytes, pcm_, dataBytes);

  *outWav = wav;
  *outLength = totalBytes;
  return true;
}

String HeadroomPtt::asrUrl() const {
  String base = httpBase_;
  if (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + "/api/operator/asr?lang=" + asrLanguage_;
}

String HeadroomPtt::operatorResponseUrl() const {
  String base = httpBase_;
  if (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + "/api/operator/response";
}

void HeadroomPtt::setState(HeadroomPttState next) {
  state_ = next;
  stateSinceMs_ = millis();
}

void HeadroomPtt::setFaceExpression(HeadroomExpression expression, float mouthOpen) {
  if (!faceState_) {
    return;
  }
  faceState_->expression = expression;
  faceState_->mouthOpen = mouthOpen;
}
