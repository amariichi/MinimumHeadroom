#pragma once

#include <Arduino.h>

#include "headroom_settings.h"

// Line-oriented USB-serial provisioning. Reuses the existing USB CDC serial
// (ARDUINO_USB_CDC_ON_BOOT=1) so a PC-side script can push Wi-Fi/token/URL
// config without the Wi-Fi setup portal.
//
// Protocol (ASCII, newline-terminated):
//   host -> atom:  RMHCFG <json>      write config to NVS
//   host -> atom:  RMHCFG?            query current config (secrets redacted)
//   atom -> host:  RMHCFG OK saved
//   atom -> host:  RMHCFG OK rebooting
//   atom -> host:  RMHCFG ERR <reason>
//   atom -> host:  RMHCFG STATE <json>
class HeadroomSerialProvision {
public:
  void begin(HeadroomSettings& settings);
  void loop();

private:
  HeadroomSettings* settings_ = nullptr;
  String line_;

  void handleLine(const String& line);
  void handleConfig(const String& json);
  void handleQuery();
};
