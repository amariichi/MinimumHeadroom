#pragma once

#include <Arduino.h>

enum class HeadroomPlacementPose {
  ScreenUp,
  SideUp,
};

constexpr int kHeadroomMaxSpeakerVolume = 200;

struct HeadroomSettingsData {
  String wifiSsid;
  String wifiPassword;
  String wifiSsid2;
  String wifiPassword2;
  String wifiSsid3;
  String wifiPassword3;
  String faceHttpBase;
  String faceWsUrl;
  // Optional mDNS hostname of the PC running face-app (e.g. "my-pc.local").
  // When set, main resolves it at boot and rewrites the host in faceWsUrl and
  // faceHttpBase to the PC's current LAN IP. Empty = mDNS disabled. Persisted to
  // NVS; never overwritten by the resolved value (the resolve is per-boot).
  String mdnsHost;
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
  // Audio encoding for AtomS3R-to-PC VAD frames. "ima_adpcm" is the fresh
  // default (4:1 lossy, integer codec); "pcm16" remains a compatibility
  // option. Persisted NVS choices are never migrated implicitly.
  String vadEncoding = "ima_adpcm";
  // Trailing low-energy frames captureAndSend keeps forwarding after the
  // last speech frame to carry the word's decay. The PC receive-gap timer
  // finalizes the turn, so this need not span endSilenceMs. Persisted to NVS.
  int vadSpeechTailFrames = 8;
  // Milliseconds after actual speaker playback ends before continuous VAD
  // reopens the shared half-duplex codec for microphone capture.
  int vadPlaybackCooldownMs = 1200;
  // Safe speaker volume, persisted to NVS and capped at 200 to avoid the
  // distorted radio-like noise observed above that level. Defaults are
  // selected per firmware target: faced Atom 112, M12 200.
  int speakerVolume = 112;
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
  static String normalizeVadEncoding(const String& value, const String& fallback = "ima_adpcm");
  static int normalizeVadPlaybackCooldownMs(int value);
  static int normalizeSpeakerVolume(int value);
  static HeadroomPlacementPose parsePlacementPose(const String& value);
  static const char* placementPoseName(HeadroomPlacementPose pose);

private:
  HeadroomSettingsData data_;
  bool loadedFromNvs_ = false;

  void loadCompileDefaults();
  void loadNvsOverrides();
};
