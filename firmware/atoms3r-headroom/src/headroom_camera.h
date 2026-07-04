#pragma once

// OV3660 camera support for the AtomS3R-M12. Compiled only into the
// env:atoms3r-m12 build; on the faced AtomS3R build (env:m5stack-atoms3r) this
// translation unit is empty, so the proven audio firmware is untouched.
#ifdef HEADROOM_M12

#include <Arduino.h>
#include <WebServer.h>

// Initializes the OV3660 with the verified M12 pin map (see
// doc/m12-camera-firmware.md) and serves JPEG snapshots as a route on the
// existing ingress WebServer. Audio (Echo Base / ES8311) uses a disjoint GPIO
// set, so the camera coexists with the proven audio/VAD path.
class HeadroomCamera {
public:
  // Brings up esp_camera. Returns false (and logs) on failure; the caller must
  // keep running so audio/VAD still work when the camera is absent or faulty.
  bool begin();
  bool ready() const { return ready_; }
  int lastError() const { return last_err_; }

  // Registers GET /snapshot on the shared WebServer. Safe to call after
  // server.begin() (ESP32 WebServer matches handlers per request). When
  // authToken is non-empty, /snapshot requires the same ?token= / Bearer /
  // X-Headroom-Auth credential as the audio ingress routes.
  void registerRoutes(WebServer& server, const String& authToken);

private:
  bool ready_ = false;
  int last_err_ = 0;
  WebServer* server_ = nullptr;
  String authToken_;

  void handleSnapshot();
  void handleStatus();
  void handleTune();
  void handleAudioTest();
  bool authorized();
};

#endif  // HEADROOM_M12
