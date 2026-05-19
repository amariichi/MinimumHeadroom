#pragma once

#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include "headroom_settings.h"

class HeadroomSetupPortal {
public:
  explicit HeadroomSetupPortal(HeadroomSettings& settings);

  bool begin();
  void handleClient();
  bool active() const;
  const String& ssid() const;
  IPAddress ip() const;

private:
  HeadroomSettings& settings_;
  WebServer server_;
  DNSServer dns_;
  String ssid_;
  String macAddress_;
  bool active_ = false;

  void handleRoot();
  void handleSave();
  void handleNotFound();
  String renderPage(const String& message);
  HeadroomSettingsData settingsFromRequest();
};
