#include "headroom_serial_provision.h"

#include <ArduinoJson.h>
#include <M5Unified.h>

namespace {

constexpr size_t kMaxLine = 1024;

// Overwrite a String field only if the JSON key is present, so a partial
// RMHCFG payload leaves untouched settings as-is.
void mergeString(JsonDocument& doc, const char* key, String& field) {
  if (doc[key].is<const char*>() || doc[key].is<String>()) {
    field = doc[key].as<String>();
  }
}

void mergeInt(JsonDocument& doc, const char* key, int& field) {
  if (doc[key].is<int>()) {
    field = doc[key].as<int>();
  }
}

void mergeBool(JsonDocument& doc, const char* key, bool& field) {
  if (doc[key].is<bool>()) {
    field = doc[key].as<bool>();
  }
}

void mergeFloat(JsonDocument& doc, const char* key, float& field) {
  if (doc[key].is<float>() || doc[key].is<double>() || doc[key].is<int>()) {
    field = doc[key].as<float>();
  }
}

}  // namespace

void HeadroomSerialProvision::begin(HeadroomSettings& settings) {
  settings_ = &settings;
  line_.reserve(kMaxLine + 1);
}

void HeadroomSerialProvision::loop() {
  if (settings_ == nullptr) {
    return;
  }
  while (Serial.available() > 0) {
    char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (line_.length() > 0) {
        String complete = line_;
        line_ = "";
        handleLine(complete);
      }
      continue;
    }
    if (line_.length() >= kMaxLine) {
      line_ = "";
      Serial.println("RMHCFG ERR overflow");
      continue;
    }
    line_ += c;
  }
}

void HeadroomSerialProvision::handleLine(const String& line) {
  if (line == "RMHCFG?") {
    handleQuery();
    return;
  }
  if (line.startsWith("RMHCFG ")) {
    handleConfig(line.substring(7));
    return;
  }
  // Anything else is ordinary log input echoed back to the host; ignore.
}

void HeadroomSerialProvision::handleConfig(const String& json) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    Serial.print("RMHCFG ERR bad_json ");
    Serial.println(error.c_str());
    return;
  }

  HeadroomSettingsData next = settings_->editable();
  mergeString(doc, "ssid", next.wifiSsid);
  mergeString(doc, "wifi_pw", next.wifiPassword);
  mergeString(doc, "ssid2", next.wifiSsid2);
  mergeString(doc, "wifi_pw2", next.wifiPassword2);
  mergeString(doc, "ssid3", next.wifiSsid3);
  mergeString(doc, "wifi_pw3", next.wifiPassword3);
  mergeString(doc, "http_base", next.faceHttpBase);
  mergeString(doc, "ws_url", next.faceWsUrl);
  mergeString(doc, "mdns_host", next.mdnsHost);
  mergeString(doc, "auth", next.authToken);
  mergeString(doc, "device_id", next.deviceId);
  mergeString(doc, "display_id", next.displayAgentId);
  mergeString(doc, "input_id", next.inputTargetAgentId);
  if (doc["asr_lang"].is<const char*>() || doc["asr_lang"].is<String>()) {
    next.asrLanguage =
        HeadroomSettings::normalizeAsrLanguage(doc["asr_lang"].as<String>(), next.asrLanguage);
  }
  mergeBool(doc, "vad_on", next.continuousVadEnabled);
  mergeFloat(doc, "vad_rms", next.vadFirmwareRms);
  mergeInt(doc, "vad_tail", next.vadSpeechTailFrames);
  if (doc["vad_enc"].is<const char*>() || doc["vad_enc"].is<String>()) {
    next.vadEncoding =
        HeadroomSettings::normalizeVadEncoding(doc["vad_enc"].as<String>(), next.vadEncoding);
  }
  mergeInt(doc, "max_b64_sec", next.maxBase64TtsSeconds);
  mergeInt(doc, "max_http_b", next.maxHttpTtsBytes);
  mergeInt(doc, "rotation", next.faceRotationDegrees);
  if (doc["pose"].is<const char*>() || doc["pose"].is<String>()) {
    next.placementPose = HeadroomSettings::parsePlacementPose(doc["pose"].as<String>());
  }
  mergeInt(doc, "up_side", next.upSideDegrees);

  if (!settings_->save(next)) {
    Serial.println("RMHCFG ERR save_failed");
    return;
  }

  if (doc["reboot"].is<bool>() && doc["reboot"].as<bool>()) {
    Serial.println("RMHCFG OK rebooting");
    Serial.flush();
    delay(100);
    ESP.restart();
    return;
  }
  Serial.println("RMHCFG OK saved");
}

void HeadroomSerialProvision::handleQuery() {
  const HeadroomSettingsData& d = settings_->data();
  JsonDocument doc;
  doc["ssid"] = d.wifiSsid;
  doc["wifi_pw_len"] = static_cast<int>(d.wifiPassword.length());
  doc["ssid2"] = d.wifiSsid2;
  doc["wifi_pw2_len"] = static_cast<int>(d.wifiPassword2.length());
  doc["ssid3"] = d.wifiSsid3;
  doc["wifi_pw3_len"] = static_cast<int>(d.wifiPassword3.length());
  doc["http_base"] = d.faceHttpBase;
  doc["ws_url"] = d.faceWsUrl;
  doc["mdns_host"] = d.mdnsHost;
  doc["auth_len"] = static_cast<int>(d.authToken.length());
  doc["device_id"] = d.deviceId;
  doc["display_id"] = d.displayAgentId;
  doc["input_id"] = d.inputTargetAgentId;
  doc["asr_lang"] = d.asrLanguage;
  doc["vad_on"] = d.continuousVadEnabled;
  doc["vad_rms"] = d.vadFirmwareRms;
  doc["vad_tail"] = d.vadSpeechTailFrames;
  doc["vad_enc"] = d.vadEncoding;
  doc["max_b64_sec"] = d.maxBase64TtsSeconds;
  doc["max_http_b"] = d.maxHttpTtsBytes;
  doc["rotation"] = d.faceRotationDegrees;
  doc["pose"] = HeadroomSettings::placementPoseName(d.placementPose);
  doc["up_side"] = d.upSideDegrees;
  doc["usable_wifi"] = settings_->usableWifiCount();

  // Live IMU readout: lets `RMHCFG?` confirm the accelerometer works and
  // calibrate the triple-tap auto-upright mapping without rebooting or
  // pressing the screen button (turn the device to each of the 4 uprights
  // and read ax/ay).
  bool imuOn = M5.Imu.isEnabled();
  doc["imu_enabled"] = imuOn;
  if (imuOn) {
    M5.Imu.update();
    float ax = 0.0f;
    float ay = 0.0f;
    float az = 0.0f;
    if (M5.Imu.getAccel(&ax, &ay, &az)) {
      doc["imu_ax"] = ax;
      doc["imu_ay"] = ay;
      doc["imu_az"] = az;
    }
  }

  Serial.print("RMHCFG STATE ");
  serializeJson(doc, Serial);
  Serial.println();
}
