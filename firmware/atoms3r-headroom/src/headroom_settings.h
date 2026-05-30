#pragma once

#include <Arduino.h>

enum class HeadroomPlacementPose {
  ScreenUp,
  SideUp,
};

struct HeadroomSettingsData {
  String wifiSsid;
  String wifiPassword;
  String wifiSsid2;
  String wifiPassword2;
  String wifiSsid3;
  String wifiPassword3;
  String faceHttpBase;
  String faceWsUrl;
  String authToken;
  String deviceId;
  String displayAgentId;
  String inputTargetAgentId;
  String asrLanguage;
  bool continuousVadEnabled = false;
  // RMS amplitude floor used by HeadroomContinuousVad::captureAndSend to
  // skip silent frames before WebSocket send. 0 disables the gate (all
  // frames are forwarded — Silero mode); values up to about 0.1 are
  // sensible. Persisted to NVS as a float.
  float vadFirmwareRms = 0.025f;
  // Audio encoding for AtomS3R-to-PC VAD frames. "pcm16" (default, raw
  // little-endian 16-bit) or "ima_adpcm" (4:1 lossy, integer codec).
  // ADPCM cuts mobile-tethered bandwidth roughly 4x and is what to
  // enable for outdoor / Silero usage. Persisted to NVS.
  String vadEncoding = "pcm16";
  // Trailing low-energy frames captureAndSend keeps forwarding after the
  // last speech frame so the PC bridge gets enough silence to finalize the
  // utterance. Must exceed endSilenceMs/64ms on the PC (>=15 for the 900 ms
  // default); 16 (~1.0 s) gives margin. 0 disables the tail (idle-skip then
  // chops at pauses). Persisted to NVS.
  int vadSpeechTailFrames = 16;
  int maxBase64TtsSeconds = 10;
  int maxHttpTtsBytes = 1200000;
  int faceRotationDegrees = 0;
  HeadroomPlacementPose placementPose = HeadroomPlacementPose::ScreenUp;
  int upSideDegrees = 0;
};

class HeadroomSettings {
public:
  void begin();
  const HeadroomSettingsData& data() const;
  HeadroomSettingsData editable() const;
  bool save(const HeadroomSettingsData& next);
  bool hasUsableWifi() const;
  bool hasSavedSettings() const;

  // Wi-Fi slot accessor. idx is 1..3; returns false for out-of-range or
  // placeholder/empty slots. slot 1 maps to wifiSsid/wifiPassword.
  bool wifiSlot(int idx, String& ssid, String& pw) const;
  int usableWifiCount() const;

  static bool isValidRotation(int degrees);
  static int normalizeRotation(int degrees);
  static String normalizeAsrLanguage(const String& value, const String& fallback = "ja");
  static String normalizeVadEncoding(const String& value, const String& fallback = "pcm16");
  static HeadroomPlacementPose parsePlacementPose(const String& value);
  static const char* placementPoseName(HeadroomPlacementPose pose);

private:
  HeadroomSettingsData data_;
  bool loadedFromNvs_ = false;

  void loadCompileDefaults();
  void loadNvsOverrides();
};
