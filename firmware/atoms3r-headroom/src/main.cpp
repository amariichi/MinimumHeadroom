#include <M5Unified.h>
#include <WiFi.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_ingress_server.h"
#include "headroom_settings.h"
#include "headroom_setup_portal.h"
#include "headroom_transport.h"

namespace {

HeadroomSettings settings;
HeadroomSetupPortal setupPortal(settings);
HeadroomAudio audio;
HeadroomTransport transport;
HeadroomIngressServer ingressServer;
HeadroomFaceRenderer renderer;
HeadroomFaceState faceState;

constexpr HeadroomExpression kExpressions[] = {
    HeadroomExpression::Neutral,
    HeadroomExpression::Thinking,
    HeadroomExpression::Speaking,
    HeadroomExpression::Listening,
    HeadroomExpression::Permission,
    HeadroomExpression::Success,
    HeadroomExpression::Failed,
};

size_t expressionIndex = 0;
uint32_t lastFrameMs = 0;
uint32_t startedMs = 0;
bool setupMode = false;
bool wifiConnected = false;
bool forcedSetupMode = false;

void applyCurrentExpression() {
  faceState.expression = kExpressions[expressionIndex];
  faceState.connected = wifiConnected;
  if (faceState.expression != HeadroomExpression::Speaking) {
    faceState.mouthOpen = 0.0f;
  }
}

void updateDemoMotion(uint32_t nowMs) {
  if (wifiConnected && !setupMode) {
    return;
  }

  float phase = static_cast<float>((nowMs - startedMs) % 1400) / 1400.0f;
  float wave = (sinf(phase * 2.0f * PI) + 1.0f) * 0.5f;

  if (faceState.expression == HeadroomExpression::Speaking) {
    faceState.mouthOpen = 0.12f + wave * 0.82f;
  } else if (faceState.expression == HeadroomExpression::Thinking) {
    faceState.gazeX = sinf(phase * 2.0f * PI) * 0.75f;
    faceState.gazeY = cosf(phase * 2.0f * PI) * 0.35f;
  } else {
    faceState.gazeX = 0.0f;
    faceState.gazeY = 0.0f;
  }
}

bool connectWifi(const HeadroomSettingsData& data, uint32_t timeoutMs) {
  if (!settings.hasUsableWifi()) {
    Serial.println("wifi missing; starting setup portal");
    return false;
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(data.wifiSsid.c_str(), data.wifiPassword.c_str());
  Serial.printf("wifi connecting ssid=%s\n", data.wifiSsid.c_str());

  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < timeoutMs) {
    M5.update();
    delay(100);
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("wifi connect failed; starting setup portal");
    WiFi.disconnect(true);
    return false;
  }

  Serial.printf("wifi connected ip=%s\n", WiFi.localIP().toString().c_str());
  return true;
}

bool shouldForceSetupPortal(uint32_t holdMs) {
  uint32_t started = millis();
  bool sawPressed = false;
  while (millis() - started < holdMs) {
    M5.update();
    if (M5.BtnA.isPressed()) {
      sawPressed = true;
      faceState.expression = HeadroomExpression::Permission;
      faceState.mouthOpen = 0.25f;
    } else if (sawPressed) {
      return false;
    }
    renderer.draw(faceState);
    delay(20);
  }
  return sawPressed;
}

void startSetupPortal() {
  setupMode = setupPortal.begin();
  wifiConnected = false;
  expressionIndex = 4;
  applyCurrentExpression();
  if (setupMode) {
    Serial.printf("setup portal ssid=%s ip=%s\n", setupPortal.ssid().c_str(), setupPortal.ip().toString().c_str());
  } else {
    Serial.println("setup portal failed to start");
  }
}

void drawSetupOverlay() {
  if (!setupMode) {
    return;
  }
  M5.Display.setTextDatum(top_left);
  M5.Display.setTextColor(TFT_WHITE, TFT_BLACK);
  M5.Display.setTextSize(1);
  M5.Display.fillRect(7, 104, 114, 22, TFT_BLACK);
  M5.Display.setCursor(9, 106);
  M5.Display.print(setupPortal.ssid());
  M5.Display.setCursor(9, 116);
  M5.Display.print(setupPortal.ip());
}

}  // namespace

void setup() {
  auto cfg = M5.config();
  cfg.serial_baudrate = 115200;
  cfg.output_power = true;
  cfg.internal_imu = false;
  cfg.internal_mic = false;
  // AtomS3R has no internal speaker. Audio output requires the external
  // Atomic Echo Base (ES8311). Without this, M5.Speaker.playWav() returns
  // true but produces no sound and the mouth sticks half-open.
  cfg.internal_spk = false;
  cfg.external_speaker.atomic_echo = true;
  M5.begin(cfg);

  Serial.println("Real Minimum Headroom AtomS3R starting");
  Serial.println("display ready");
  Serial.println("demo face mode");

  settings.begin();
  const HeadroomSettingsData& data = settings.data();
  Serial.printf("device_id=%s saved_settings=%s\n", data.deviceId.c_str(), settings.hasSavedSettings() ? "yes" : "no");

  startedMs = millis();
  renderer.begin(128, 128, data.faceRotationDegrees);
  audio.begin(data);
  forcedSetupMode = shouldForceSetupPortal(2000);
  if (forcedSetupMode) {
    Serial.println("button held at boot; forcing setup portal");
  }

  wifiConnected = forcedSetupMode ? false : connectWifi(data, 8000);
  if (!wifiConnected) {
    startSetupPortal();
  } else {
    faceState.expression = HeadroomExpression::Thinking;
    faceState.connected = true;
    transport.begin(data, faceState, audio);
    ingressServer.begin(data, transport, audio, faceState);
  }

  if (!wifiConnected) {
    applyCurrentExpression();
  }
  renderer.draw(faceState);
  drawSetupOverlay();
}

void loop() {
  M5.update();
  setupPortal.handleClient();
  audio.loop();
  if (!setupMode && wifiConnected) {
    ingressServer.loop();
    transport.loop();
    faceState.connected = transport.connected() || ingressServer.recentlyActive(10000);
  }
  uint32_t nowMs = millis();

  if ((!wifiConnected || setupMode) && M5.BtnA.wasPressed()) {
    expressionIndex = (expressionIndex + 1) % (sizeof(kExpressions) / sizeof(kExpressions[0]));
    applyCurrentExpression();
    Serial.printf("expression index=%u\n", static_cast<unsigned>(expressionIndex));
  }

  if (nowMs - lastFrameMs >= 33) {
    updateDemoMotion(nowMs);
    renderer.draw(faceState);
    drawSetupOverlay();
    lastFrameMs = nowMs;
  }
}
