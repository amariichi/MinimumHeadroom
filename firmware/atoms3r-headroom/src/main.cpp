#include <ESPmDNS.h>
#include <M5Unified.h>
#include <WiFi.h>

#include <math.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_continuous_vad.h"
#include "headroom_ingress_server.h"
#include "headroom_ptt.h"
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
HeadroomPtt ptt;
HeadroomContinuousVad continuousVad;
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

// Screen-button tap gesture state. A press shorter than kTapMaxMs is a "tap";
// three taps within kMultiTapGapMs of each other rotate the face 90° CW. A
// longer hold is reserved for PTT (>= HeadroomPtt::kArmMs) and never counts as
// a tap, so the two gestures never collide.
constexpr uint32_t kTapMaxMs = 350;
constexpr uint32_t kMultiTapGapMs = 600;
uint32_t btnPressStartMs = 0;
bool btnDownPrev = false;
uint32_t lastTapMs = 0;
int tapCount = 0;

void applyCurrentExpression() {
  faceState.expression = kExpressions[expressionIndex];
  faceState.connected = wifiConnected;
  if (faceState.expression != HeadroomExpression::Speaking) {
    faceState.mouthOpen = 0.0f;
  }
}

// Minimum in-plane gravity (g) to trust the IMU for "which edge is up". Below
// this the screen is too close to horizontal (flat on a desk) and the screen-
// plane direction is just noise, so we fall back to a manual +90 step.
constexpr float kImuInPlaneMinG = 0.40f;
// Board calibration: maps the screen-plane gravity angle to a faceRotation.
// atan2(ay,ax) snapped to 90s, then offset/sign applied. The AtomS3R IMU axis
// orientation vs. the panel is not verifiable without hardware; the boot log
// prints raw accel + chosen rotation so these two can be fixed in one
// on-device calibration pass.
//
// Calibrated 2026-05-19 on real hardware. With offset=0/sign=+1 the observed
// face direction was the mirror of the wanted one plus 90°:
//   device-top up   -> face right (want up)
//   device-right up  -> face up    (want right)
//   device-left up   -> face down  (want left)
//   device-bottom up -> face left  (want down)
// i.e. want = (-got + 90) mod 360, so sign=-1, offset=90.
constexpr int kImuRotationOffsetDeg = 90;
constexpr int kImuRotationSign = -1;

// Returns true and sets outDeg to one of 0/90/180/270 when the accelerometer
// gives a confident in-plane "up". Returns false when too flat / no IMU.
bool imuUprightRotation(int& outDeg) {
  if (!M5.Imu.isEnabled()) {
    return false;
  }
  M5.Imu.update();
  float ax = 0.0f;
  float ay = 0.0f;
  float az = 0.0f;
  if (!M5.Imu.getAccel(&ax, &ay, &az)) {
    return false;
  }
  float inPlane = sqrtf(ax * ax + ay * ay);
  Serial.printf("imu accel x=%.2f y=%.2f z=%.2f inplane=%.2f\n", ax, ay, az, inPlane);
  if (inPlane < kImuInPlaneMinG) {
    return false;
  }
  float deg = atan2f(ay, ax) * 180.0f / static_cast<float>(PI);
  int snapped = static_cast<int>(roundf(deg / 90.0f)) * 90;
  int rot = HeadroomSettings::normalizeRotation(kImuRotationOffsetDeg +
                                                kImuRotationSign * snapped);
  Serial.printf("imu upright deg=%.1f snapped=%d -> rotation=%d\n", deg, snapped, rot);
  outDeg = rot;
  return true;
}

void applyTripleTapRotation() {
  HeadroomSettingsData next = settings.editable();
  int imuDeg = 0;
  if (imuUprightRotation(imuDeg)) {
    next.faceRotationDegrees = imuDeg;
    Serial.println("triple-tap: IMU auto-upright");
  } else {
    next.faceRotationDegrees =
        HeadroomSettings::normalizeRotation(next.faceRotationDegrees + 90);
    Serial.println("triple-tap: flat/no-IMU, +90 step");
  }
  settings.save(next);
  renderer.setRotationDegrees(next.faceRotationDegrees);
  // Brief visible confirmation; normal state flow overwrites it shortly.
  faceState.expression = HeadroomExpression::Success;
  faceState.mouthOpen = 0.0f;
  Serial.printf("face rotation -> %d deg\n", next.faceRotationDegrees);
}

// Before-playback callback used by both HeadroomTransport (direct WS TTS) and
// HeadroomIngressServer (HTTP TTS bridge). Goes through the state machine so
// VAD enters Cooldown and resists thrash on the very next update() tick after
// playback finishes; calling stop() directly would skip the cooldown gate.
void suspendContinuousVadForPlayback(void*) {
  continuousVad.suspendForPlayback();
}

// Pre-recording callback for HeadroomPtt. Fires before audio_->stopForRecording()
// so the VAD state machine transitions to SuspendedForPtt and bumps generation
// BEFORE the shared codec is reconfigured to ADC mode.
void suspendContinuousVadForPtt(void*) {
  continuousVad.suspendForPtt();
}

void setContinuousVadEnabled(bool enabled) {
  HeadroomSettingsData next = settings.editable();
  if (next.continuousVadEnabled == enabled) {
    return;
  }
  next.continuousVadEnabled = enabled;
  if (!settings.save(next)) {
    faceState.expression = HeadroomExpression::Failed;
    faceState.mouthOpen = 0.0f;
    Serial.println("continuous VAD toggle save failed");
    return;
  }
  ingressServer.setContinuousVadEnabled(next.continuousVadEnabled);
  continuousVad.setEnabled(next.continuousVadEnabled);
  faceState.expression = next.continuousVadEnabled ? HeadroomExpression::Listening : HeadroomExpression::Neutral;
  faceState.mouthOpen = 0.0f;
  Serial.printf("continuous VAD -> %s\n", next.continuousVadEnabled ? "on" : "off");
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

// Swap only the host portion of a "scheme://host[:port][/path]" URL, leaving the
// scheme, port, and path intact. Used to retarget faceWsUrl/faceHttpBase at the
// PC's freshly resolved mDNS IP without disturbing the configured port/path.
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

// If an mDNS host is provisioned, resolve it once at boot and rewrite the host
// in both server URLs to the PC's current LAN IP. On any failure the static
// faceWsUrl/faceHttpBase are left untouched (fallback). mDNS does not cross
// subnets, so off-LAN the resolve fails and the static URLs (ideally a stable
// Tailscale IP) carry the connection. Mutates the caller's runtime copy only;
// the provisioned mdns_host in NVS is never overwritten.
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
  // IMU on: the triple-tap gesture uses the accelerometer to auto-detect
  // which screen edge is up (4-way snap) when the device is tilted. Verified
  // on hardware to coexist with ES8311 audio and the PTT cue tone.
  cfg.internal_imu = true;
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
  Serial.printf("imu_enabled=%s\n", M5.Imu.isEnabled() ? "yes" : "no");

  settings.begin();
  serialProvision.begin(settings);
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
    // Mutable per-boot copy so an mDNS-resolved PC IP can be folded into the
    // server URLs before any subsystem captures them. The persisted settings
    // (and the static URL fallback) stay untouched.
    HeadroomSettingsData runtimeData = data;
    resolveMdnsHost(runtimeData);
    // audio.begin() ran before Wi-Fi (above), so push the possibly-resolved
    // HTTP base into it now that mDNS has had its say.
    audio.setHttpBase(runtimeData.faceHttpBase);
    faceState.expression = HeadroomExpression::Thinking;
    faceState.connected = true;
    transport.begin(runtimeData, faceState, audio);
    ingressServer.begin(runtimeData, transport, audio, faceState);
    ingressServer.setBeforeAudioPlaybackCallback(&suspendContinuousVadForPlayback, nullptr);
    ptt.begin(runtimeData, audio, transport, faceState);
    ptt.setBeforeRecordingCallback(&suspendContinuousVadForPtt, nullptr);
    continuousVad.begin(runtimeData, audio, transport, faceState);
  }

  if (!wifiConnected) {
    applyCurrentExpression();
  }
  renderer.draw(faceState);
  drawSetupOverlay();
}

void loop() {
  M5.update();
  serialProvision.loop();
  setupPortal.handleClient();
  audio.loop();
  if (!setupMode && wifiConnected) {
    // Press-edge: suspend continuous VAD capture immediately so a long-hold
    // for PTT does not race with VAD owning the mic, but do NOT persist the
    // VAD-off setting here. Persistence is reserved for the short-tap-confirmed
    // path below (tapCount == 1 after the gap timer expires), so a long hold
    // for PTT no longer doubles as a destructive NVS write of the VAD setting.
    {
      bool pressedNow = M5.BtnA.isPressed();
      if (pressedNow && !btnDownPrev && settings.data().continuousVadEnabled) {
        continuousVad.suspendForPtt();
      }
    }
    ptt.update();
    if (!ptt.recording()) {
      ingressServer.loop();
      transport.loop();
      continuousVad.update();
    }
    faceState.connected = transport.connected() || ingressServer.recentlyActive(10000);

    // Device-authoritative 口パク: while speaking, drive the mouth from the
    // PCM this device is actually playing, not the PC-side tts_mouth stream.
    // The streamed envelope is timed to the worker's local playback clock and
    // accumulates a per-chunk lag here, so on a long utterance the mouth
    // finishes well before the audio. Sampling our own playback removes the
    // cross-clock drift entirely.
    if (!ptt.recording()) {
      // Call unconditionally: currentMouthOpen() also advances the release
      // tail across inter-chunk gaps and the post-isPlaying() codec drain.
      float deviceMouth = audio.currentMouthOpen();

      // While THIS device is still emitting audio it is the sole authority on
      // whether we are speaking. The PC-side play_stop / tts_mouth=0 fire when
      // the *worker* finishes, which is earlier than this device drains its
      // chunked-TTS backlog; letting transport flip the face to Neutral there
      // is what shuts the mouth before the audio actually ends (worse the
      // longer the utterance, since the backlog grows with length).
      if (audio.busy() || deviceMouth > 0.0f) {
        faceState.expression = HeadroomExpression::Speaking;
        faceState.mouthOpen = deviceMouth;
      } else {
        // Device is silent: the mouth must be shut regardless of expression.
        // Guarding this on Speaking left it frozen half-open whenever the
        // PC-side play_stop had already flipped the face to Neutral while the
        // release tail was still decaying.
        faceState.mouthOpen = 0.0f;
      }
    }
  }
  uint32_t nowMs = millis();

  // Unified screen-button tap gesture (all modes). In connected mode, the
  // press edge above suspends continuous VAD capture without persisting any
  // setting; a single-tap-confirmed gesture (tapCount == 1 after the gap
  // timer expires) persists VAD off as an escape hatch when VAD is on;
  // a double-tap-confirmed gesture (tapCount == 2) toggles VAD on or off
  // — the only on-device way to ENABLE VAD without re-provisioning. A long
  // hold does NOT count as a tap and does NOT persist any VAD setting, so
  // PTT stays non-destructive. In offline/setup mode, short taps cycle the
  // expression preview. Three quick taps rotate the face 90° clockwise and
  // persist it. A long hold falls through to PTT when connected.
  {
    bool down = M5.BtnA.isPressed();
    if (down && !btnDownPrev) {
      btnPressStartMs = nowMs;
    } else if (!down && btnDownPrev) {
      uint32_t dur = nowMs - btnPressStartMs;
      if (dur < kTapMaxMs) {
        tapCount = (nowMs - lastTapMs <= kMultiTapGapMs) ? tapCount + 1 : 1;
        lastTapMs = nowMs;
        if (!wifiConnected || setupMode) {
          expressionIndex =
              (expressionIndex + 1) % (sizeof(kExpressions) / sizeof(kExpressions[0]));
          applyCurrentExpression();
          Serial.printf("expression index=%u\n", static_cast<unsigned>(expressionIndex));
        }
        if (tapCount >= 3) {
          applyTripleTapRotation();
          tapCount = 0;
        }
      } else {
        tapCount = 0;
      }
    }
    if (tapCount > 0 && nowMs - lastTapMs > kMultiTapGapMs) {
      if (wifiConnected && !setupMode) {
        if (tapCount == 1 && settings.data().continuousVadEnabled) {
          // Short-tap escape hatch: persist VAD off when it is currently on.
          // A single tap on a device with VAD already off is a no-op so the
          // gesture cannot accidentally disrupt anything else.
          setContinuousVadEnabled(false);
        } else if (tapCount == 2) {
          // Double-tap: toggle continuous VAD. This is the only on-device
          // gesture that can ENABLE VAD; otherwise the user must reach the
          // provisioning script. The toggle direction is determined by the
          // current persisted setting so off→on enables and on→off mirrors
          // the single-tap escape hatch.
          setContinuousVadEnabled(!settings.data().continuousVadEnabled);
        }
      }
      tapCount = 0;
    }
    btnDownPrev = down;
  }

  if (nowMs - lastFrameMs >= 33) {
    updateDemoMotion(nowMs);
    renderer.draw(faceState);
    drawSetupOverlay();
    lastFrameMs = nowMs;
  }
}
