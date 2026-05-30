#include "headroom_settings.h"

#include <Preferences.h>

#include "headroom_config.h"

namespace {

constexpr const char* kNamespace = "rmh";

bool isPlaceholderWifi(const String& ssid) {
  return ssid.length() == 0 || ssid == "your-wifi";
}

String readString(Preferences& prefs, const char* key, const String& fallback) {
  if (!prefs.isKey(key)) {
    return fallback;
  }
  return prefs.getString(key, fallback);
}

int readInt(Preferences& prefs, const char* key, int fallback) {
  if (!prefs.isKey(key)) {
    return fallback;
  }
  return prefs.getInt(key, fallback);
}

bool readBool(Preferences& prefs, const char* key, bool fallback) {
  if (!prefs.isKey(key)) {
    return fallback;
  }
  return prefs.getBool(key, fallback);
}

float readFloat(Preferences& prefs, const char* key, float fallback) {
  if (!prefs.isKey(key)) {
    return fallback;
  }
  return prefs.getFloat(key, fallback);
}

}  // namespace

void HeadroomSettings::begin() {
  loadCompileDefaults();
  loadNvsOverrides();
}

const HeadroomSettingsData& HeadroomSettings::data() const {
  return data_;
}

HeadroomSettingsData HeadroomSettings::editable() const {
  return data_;
}

bool HeadroomSettings::save(const HeadroomSettingsData& next) {
  HeadroomSettingsData normalized = next;
  normalized.faceRotationDegrees = normalizeRotation(normalized.faceRotationDegrees);
  normalized.upSideDegrees = normalizeRotation(normalized.upSideDegrees);
  normalized.asrLanguage = normalizeAsrLanguage(normalized.asrLanguage);
  normalized.vadEncoding = normalizeVadEncoding(normalized.vadEncoding);
  if (normalized.vadSpeechTailFrames < 0) {
    normalized.vadSpeechTailFrames = 0;
  } else if (normalized.vadSpeechTailFrames > 240) {
    normalized.vadSpeechTailFrames = 240;
  }

  Preferences prefs;
  if (!prefs.begin(kNamespace, false)) {
    return false;
  }

  prefs.putString("ssid", normalized.wifiSsid);
  prefs.putString("wifi_pw", normalized.wifiPassword);
  prefs.putString("ssid2", normalized.wifiSsid2);
  prefs.putString("wifi_pw2", normalized.wifiPassword2);
  prefs.putString("ssid3", normalized.wifiSsid3);
  prefs.putString("wifi_pw3", normalized.wifiPassword3);
  prefs.putString("http_base", normalized.faceHttpBase);
  prefs.putString("ws_url", normalized.faceWsUrl);
  prefs.putString("auth", normalized.authToken);
  prefs.putString("device_id", normalized.deviceId);
  prefs.putString("display_id", normalized.displayAgentId);
  prefs.putString("input_id", normalized.inputTargetAgentId);
  prefs.putString("asr_lang", normalized.asrLanguage);
  prefs.putBool("vad_on", normalized.continuousVadEnabled);
  prefs.putFloat("vad_rms", normalized.vadFirmwareRms);
  prefs.putString("vad_enc", normalized.vadEncoding);
  prefs.putInt("vad_tail", normalized.vadSpeechTailFrames);
  prefs.putInt("max_b64_sec", normalized.maxBase64TtsSeconds);
  prefs.putInt("max_http_b", normalized.maxHttpTtsBytes);
  prefs.putInt("rotation", normalized.faceRotationDegrees);
  prefs.putString("pose", placementPoseName(normalized.placementPose));
  prefs.putInt("up_side", normalized.upSideDegrees);
  prefs.end();

  data_ = normalized;
  loadedFromNvs_ = true;
  return true;
}

bool HeadroomSettings::hasUsableWifi() const {
  return usableWifiCount() > 0;
}

bool HeadroomSettings::wifiSlot(int idx, String& ssid, String& pw) const {
  String s;
  String p;
  if (idx == 1) {
    s = data_.wifiSsid;
    p = data_.wifiPassword;
  } else if (idx == 2) {
    s = data_.wifiSsid2;
    p = data_.wifiPassword2;
  } else if (idx == 3) {
    s = data_.wifiSsid3;
    p = data_.wifiPassword3;
  } else {
    return false;
  }
  if (isPlaceholderWifi(s)) {
    return false;
  }
  ssid = s;
  pw = p;
  return true;
}

int HeadroomSettings::usableWifiCount() const {
  int count = 0;
  String s;
  String p;
  for (int idx = 1; idx <= 3; ++idx) {
    if (wifiSlot(idx, s, p)) {
      ++count;
    }
  }
  return count;
}

bool HeadroomSettings::hasSavedSettings() const {
  return loadedFromNvs_;
}

bool HeadroomSettings::isValidRotation(int degrees) {
  return degrees == 0 || degrees == 90 || degrees == 180 || degrees == 270;
}

int HeadroomSettings::normalizeRotation(int degrees) {
  int normalized = ((degrees % 360) + 360) % 360;
  if (normalized < 45 || normalized >= 315) {
    return 0;
  }
  if (normalized < 135) {
    return 90;
  }
  if (normalized < 225) {
    return 180;
  }
  return 270;
}

HeadroomPlacementPose HeadroomSettings::parsePlacementPose(const String& value) {
  if (value == "side_up" || value == "screen_forward") {
    return HeadroomPlacementPose::SideUp;
  }
  return HeadroomPlacementPose::ScreenUp;
}

String HeadroomSettings::normalizeVadEncoding(const String& value, const String& fallback) {
  String normalized = value;
  normalized.trim();
  normalized.toLowerCase();
  if (normalized == "ima_adpcm" || normalized == "adpcm") {
    return "ima_adpcm";
  }
  if (normalized == "pcm16" || normalized == "pcm") {
    return "pcm16";
  }
  String normalizedFallback = fallback;
  normalizedFallback.trim();
  normalizedFallback.toLowerCase();
  return normalizedFallback == "ima_adpcm" ? "ima_adpcm" : "pcm16";
}

String HeadroomSettings::normalizeAsrLanguage(const String& value, const String& fallback) {
  String normalized = value;
  normalized.trim();
  normalized.toLowerCase();
  if (normalized.startsWith("ja")) {
    return "ja";
  }
  if (normalized.startsWith("en")) {
    return "en";
  }
  String normalizedFallback = fallback;
  normalizedFallback.trim();
  normalizedFallback.toLowerCase();
  return normalizedFallback.startsWith("en") ? "en" : "ja";
}

const char* HeadroomSettings::placementPoseName(HeadroomPlacementPose pose) {
  switch (pose) {
    case HeadroomPlacementPose::SideUp:
      return "side_up";
    case HeadroomPlacementPose::ScreenUp:
    default:
      return "screen_up";
  }
}

void HeadroomSettings::loadCompileDefaults() {
  data_.wifiSsid = HEADROOM_WIFI_SSID;
  data_.wifiPassword = HEADROOM_WIFI_PASSWORD;
  data_.wifiSsid2 = HEADROOM_WIFI_SSID2;
  data_.wifiPassword2 = HEADROOM_WIFI_PASSWORD2;
  data_.wifiSsid3 = HEADROOM_WIFI_SSID3;
  data_.wifiPassword3 = HEADROOM_WIFI_PASSWORD3;
  data_.faceHttpBase = HEADROOM_FACE_HTTP_BASE;
  data_.faceWsUrl = HEADROOM_FACE_WS_URL;
  data_.authToken = HEADROOM_FACE_AUTH_TOKEN;
  data_.deviceId = HEADROOM_DEVICE_ID;
  data_.displayAgentId = HEADROOM_DISPLAY_AGENT_ID;
  data_.inputTargetAgentId = HEADROOM_INPUT_TARGET_AGENT_ID;
  data_.asrLanguage = normalizeAsrLanguage(HEADROOM_ASR_LANGUAGE);
  data_.continuousVadEnabled = HEADROOM_CONTINUOUS_VAD_ENABLED != 0;
  data_.vadFirmwareRms = HEADROOM_VAD_FIRMWARE_RMS;
  data_.vadEncoding = normalizeVadEncoding(HEADROOM_VAD_ENCODING);
  data_.vadSpeechTailFrames = HEADROOM_VAD_SPEECH_TAIL_FRAMES;
  data_.maxBase64TtsSeconds = HEADROOM_MAX_BASE64_TTS_SECONDS;
  data_.maxHttpTtsBytes = HEADROOM_MAX_HTTP_TTS_BYTES;
  data_.faceRotationDegrees = normalizeRotation(HEADROOM_FACE_ROTATION_DEGREES);
  data_.placementPose = parsePlacementPose(HEADROOM_PLACEMENT_POSE);
  data_.upSideDegrees = normalizeRotation(HEADROOM_UP_SIDE_DEGREES);
}

void HeadroomSettings::loadNvsOverrides() {
  String compileAuthToken = data_.authToken;
  String compileHttpBase = data_.faceHttpBase;
  String compileWsUrl = data_.faceWsUrl;

  Preferences prefs;
  if (!prefs.begin(kNamespace, true)) {
    loadedFromNvs_ = false;
    return;
  }

  loadedFromNvs_ = prefs.isKey("device_id") || prefs.isKey("ssid") || prefs.isKey("ws_url");
  data_.wifiSsid = readString(prefs, "ssid", data_.wifiSsid);
  data_.wifiPassword = readString(prefs, "wifi_pw", data_.wifiPassword);
  data_.wifiSsid2 = readString(prefs, "ssid2", data_.wifiSsid2);
  data_.wifiPassword2 = readString(prefs, "wifi_pw2", data_.wifiPassword2);
  data_.wifiSsid3 = readString(prefs, "ssid3", data_.wifiSsid3);
  data_.wifiPassword3 = readString(prefs, "wifi_pw3", data_.wifiPassword3);
  data_.faceHttpBase = readString(prefs, "http_base", data_.faceHttpBase);
  data_.faceWsUrl = readString(prefs, "ws_url", data_.faceWsUrl);
  if ((data_.faceHttpBase.indexOf("192.168.1.10") >= 0) &&
      compileHttpBase.length() > 0) {
    data_.faceHttpBase = compileHttpBase;
  }
  if ((data_.faceWsUrl.indexOf("192.168.1.10") >= 0) &&
      compileWsUrl.length() > 0) {
    data_.faceWsUrl = compileWsUrl;
  }
  data_.authToken = readString(prefs, "auth", data_.authToken);
  if (data_.authToken.length() == 0 && compileAuthToken.length() > 0) {
    data_.authToken = compileAuthToken;
  }
  data_.deviceId = readString(prefs, "device_id", data_.deviceId);
  data_.displayAgentId = readString(prefs, "display_id", data_.displayAgentId);
  data_.inputTargetAgentId = readString(prefs, "input_id", data_.inputTargetAgentId);
  data_.asrLanguage = normalizeAsrLanguage(readString(prefs, "asr_lang", data_.asrLanguage));
  data_.continuousVadEnabled = readBool(prefs, "vad_on", data_.continuousVadEnabled);
  {
    const float rawRms = readFloat(prefs, "vad_rms", data_.vadFirmwareRms);
    data_.vadFirmwareRms = rawRms < 0.0f ? 0.0f : (rawRms > 1.0f ? 1.0f : rawRms);
  }
  data_.vadEncoding = normalizeVadEncoding(readString(prefs, "vad_enc", data_.vadEncoding));
  {
    const int rawTail = readInt(prefs, "vad_tail", data_.vadSpeechTailFrames);
    data_.vadSpeechTailFrames = rawTail < 0 ? 0 : (rawTail > 240 ? 240 : rawTail);
  }
  data_.maxBase64TtsSeconds = readInt(prefs, "max_b64_sec", data_.maxBase64TtsSeconds);
  data_.maxHttpTtsBytes = readInt(prefs, "max_http_b", data_.maxHttpTtsBytes);
  data_.faceRotationDegrees = normalizeRotation(readInt(prefs, "rotation", data_.faceRotationDegrees));
  data_.placementPose = parsePlacementPose(readString(prefs, "pose", placementPoseName(data_.placementPose)));
  data_.upSideDegrees = normalizeRotation(readInt(prefs, "up_side", data_.upSideDegrees));
  prefs.end();
}
