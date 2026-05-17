#pragma once

#include <Arduino.h>

enum class HeadroomPlacementPose {
  ScreenUp,
  SideUp,
};

struct HeadroomSettingsData {
  String wifiSsid;
  String wifiPassword;
  String faceHttpBase;
  String faceWsUrl;
  String authToken;
  String deviceId;
  String displayAgentId;
  String inputTargetAgentId;
  String asrLanguage;
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

  static bool isValidRotation(int degrees);
  static int normalizeRotation(int degrees);
  static String normalizeAsrLanguage(const String& value, const String& fallback = "ja");
  static HeadroomPlacementPose parsePlacementPose(const String& value);
  static const char* placementPoseName(HeadroomPlacementPose pose);

private:
  HeadroomSettingsData data_;
  bool loadedFromNvs_ = false;

  void loadCompileDefaults();
  void loadNvsOverrides();
};
