// Entry point for the AtomS3R-M12 (camera) build (env:atoms3r-m12).
//
// The M12 is the same controller as the faced AtomS3R but with an OV3660 camera
// and NO LCD / IMU face / screen button. Rather than litter the proven faced
// main.cpp with #ifdefs, the M12 env excludes main.cpp + face_renderer.cpp via
// build_src_filter and uses this dedicated entry point. The faced firmware is
// therefore byte-for-byte unchanged. The Wi-Fi connect + mDNS host-resolve
// helpers are intentionally duplicated from main.cpp; they are stable and small.
#ifdef HEADROOM_M12

#include <ESPmDNS.h>
#include <M5Unified.h>
#include <WiFi.h>

#include "face_renderer.h"  // HeadroomFaceState/Expression (POD) for the audio path
#include "headroom_audio.h"
#include "headroom_camera.h"
#include "headroom_continuous_vad.h"
#include "headroom_ingress_server.h"
#include "headroom_serial_provision.h"
#include "headroom_settings.h"
#include "headroom_setup_portal.h"
#include "headroom_transport.h"

namespace {

HeadroomSettings settings;
HeadroomSerialProvision serialProvision;
HeadroomSetupPortal setupPortal(settings);
HeadroomAudio audio;
HeadroomTransport transport;
HeadroomIngressServer ingressServer;
HeadroomContinuousVad continuousVad;
HeadroomCamera camera;

// Shared expression/mouth state consumed by the audio/transport/VAD path. The
// M12 has no LCD, so it is never rendered; it just satisfies their signatures.
HeadroomFaceState faceState;

bool setupMode = false;
bool wifiConnected = false;

// Before-playback callback: routes through the VAD state machine so it enters
// Cooldown on the next update() tick (calling stop() directly skips the gate).
void suspendContinuousVadForPlayback(void*) {
  continuousVad.suspendForPlayback();
}

// --- Wi-Fi connect (duplicated from main.cpp, kept in sync) ---
bool connectWifi(const HeadroomSettingsData& data, uint32_t timeoutMs) {
  (void)data;
  if (!settings.hasUsableWifi()) {
    Serial.println("wifi missing; starting setup portal");
    return false;
  }

  WiFi.mode(WIFI_STA);

  for (int slot = 1; slot <= 3; ++slot) {
    String ssid;
    String pw;
    if (!settings.wifiSlot(slot, ssid, pw)) {
      continue;
    }

    Serial.printf("wifi slot %d connecting ssid=%s\n", slot, ssid.c_str());
    WiFi.disconnect(true);
    delay(50);
    WiFi.begin(ssid.c_str(), pw.c_str());

    uint32_t started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) {
      M5.update();
      delay(100);
    }

    if (WiFi.status() == WL_CONNECTED) {
      Serial.printf("wifi connected slot=%d ssid=%s ip=%s\n", slot, ssid.c_str(),
                    WiFi.localIP().toString().c_str());
      return true;
    }

    Serial.printf("wifi slot %d connect failed\n", slot);
  }

  Serial.println("all wifi slots failed; starting setup portal");
  WiFi.disconnect(true);
  return false;
}

// Swap only the host portion of a "scheme://host[:port][/path]" URL.
String replaceUrlHost(const String& url, const String& newHost) {
  int schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) {
    return url;
  }
  int authStart = schemeEnd + 3;
  int pathStart = url.indexOf('/', authStart);
  String authority = pathStart >= 0 ? url.substring(authStart, pathStart) : url.substring(authStart);
  String rest = pathStart >= 0 ? url.substring(pathStart) : String();
  int portStart = authority.indexOf(':');
  String portPart = portStart >= 0 ? authority.substring(portStart) : String();  // keeps leading ':'
  return url.substring(0, authStart) + newHost + portPart + rest;
}

// Resolve a provisioned mDNS host once at boot and rewrite the host in the
// server URLs to the PC's current LAN IP. On failure the static URLs are kept
// (off-LAN, those should be a stable Tailscale IP). Mutates the caller's copy
// only; the provisioned mdns_host in NVS is never overwritten.
void resolveMdnsHost(HeadroomSettingsData& data) {
  if (data.mdnsHost.length() == 0) {
    return;
  }
  String host = data.mdnsHost;
  host.trim();
  if (host.endsWith(".local")) {
    host = host.substring(0, host.length() - 6);  // queryHost() appends .local itself
  }
  if (host.length() == 0) {
    return;
  }
  if (!MDNS.begin(data.deviceId.c_str())) {
    Serial.println("mdns: MDNS.begin failed; keeping static ws_url/http_base");
    return;
  }
  IPAddress ip = MDNS.queryHost(host, 2000);
  if (static_cast<uint32_t>(ip) == 0) {
    Serial.printf("mdns: resolve failed for %s.local; keeping static ws_url/http_base\n", host.c_str());
    return;
  }
  String ipStr = ip.toString();
  Serial.printf("mdns: %s.local -> %s\n", host.c_str(), ipStr.c_str());
  if (data.faceWsUrl.length() > 0) {
    data.faceWsUrl = replaceUrlHost(data.faceWsUrl, ipStr);
  }
  if (data.faceHttpBase.length() > 0) {
    data.faceHttpBase = replaceUrlHost(data.faceHttpBase, ipStr);
  }
}

void startSetupPortal() {
  setupMode = setupPortal.begin();
  wifiConnected = false;
  if (setupMode) {
    Serial.printf("setup portal ssid=%s ip=%s\n", setupPortal.ssid().c_str(),
                  setupPortal.ip().toString().c_str());
  } else {
    Serial.println("setup portal failed to start");
  }
}

}  // namespace

void setup() {
  // GPIO18 (camera power-enable, active-low) pulled low early for the OV3660.
  // (Confirmed unrelated to the Echo Base audio fault: speaker stays disabled
  // regardless of GPIO18 timing.)
  pinMode(18, OUTPUT);
  digitalWrite(18, LOW);

  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.output_power = true;
  cfg.internal_imu = false;  // M12 has no face to rotate
  cfg.internal_mic = false;  // see + speak node; no voice input needed
  // Echo Base (ES8311) speech output. The M12 (no LCD) is auto-detected as
  // board_M5AtomVoiceS3R, whose speaker path uses I2S pins that collide with the
  // camera data lines and a codec init that does not power the external Atomic
  // Echo Base's amp. The pre-build hook scripts/apply_m5unified_board_patch.py
  // forces board_M5AtomS3RCam so M5Unified uses the atomic_echo path instead
  // (I2S bck=8/ws=6/dout=5, disjoint from the camera; ES8311 control time-shared
  // on I2C port 1 pins 38/39; PI4IOE power amp enabled). external_speaker is set
  // here; internal_spk stays false (the atomic_echo path provides the speaker).
  cfg.internal_spk = false;
  cfg.external_speaker.atomic_echo = true;
  M5.begin(cfg);

  // The atomic_echo path would also bring up the ES8311 mic. The M12 needs no
  // voice input, and a live ADC injects a buzz into full-duplex playback, so end
  // the mic. (The continuous VAD is likewise never started below.)
  M5.Mic.end();

  Serial.println("Real Minimum Headroom AtomS3R-M12 (camera) starting");

  settings.begin();
  serialProvision.begin(settings);
  const HeadroomSettingsData& data = settings.data();
  Serial.printf("device_id=%s saved_settings=%s\n", data.deviceId.c_str(),
                settings.hasSavedSettings() ? "yes" : "no");

  audio.begin(data);

  wifiConnected = connectWifi(data, 8000);
  if (!wifiConnected) {
    startSetupPortal();
    return;
  }

  // Mutable per-boot copy so an mDNS-resolved PC IP can be folded into the
  // server URLs before any subsystem captures them.
  HeadroomSettingsData runtimeData = data;
  resolveMdnsHost(runtimeData);
  audio.setHttpBase(runtimeData.faceHttpBase);
  faceState.expression = HeadroomExpression::Thinking;
  faceState.connected = true;

  transport.begin(runtimeData, faceState, audio);
  ingressServer.begin(runtimeData, transport, audio, faceState);
  ingressServer.setBeforeAudioPlaybackCallback(&suspendContinuousVadForPlayback, nullptr);

  // The M12 is a see + speak node: camera in, Echo Base (ES8311) speech out. The
  // continuous VAD (ES8311 mic) is intentionally NOT started — no voice input is
  // needed here, and keeping the mic off (with M5.Mic.end() above) avoids
  // ES8311 full-duplex artifacts during playback. The camera SCCB shares I2C
  // port 1 with the ES8311 control bus, but M5Unified's atomic_echo codec uses
  // an i2c_temporary_switcher (port 1 -> pins 38/39 -> restore) per access, so
  // the two coexist.
  camera.begin();
  camera.registerRoutes(ingressServer.server(), runtimeData.authToken);
  Serial.printf("camera: ready=%d err=0x%x\n", camera.ready() ? 1 : 0,
                static_cast<unsigned>(camera.lastError()));
}

void loop() {
  M5.update();
  serialProvision.loop();
  setupPortal.handleClient();
  audio.loop();
  if (!setupMode && wifiConnected) {
    ingressServer.loop();
    transport.loop();
    faceState.connected = transport.connected() || ingressServer.recentlyActive(10000);
  }
}

#endif  // HEADROOM_M12
