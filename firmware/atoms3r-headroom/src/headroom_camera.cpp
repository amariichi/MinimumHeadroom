#include "headroom_camera.h"

#ifdef HEADROOM_M12

#include <M5Unified.h>
#include <WiFi.h>

#include "esp_camera.h"

namespace {

// Verified OV3660 -> ESP32-S3-PICO-1-N8R8 pin map. Source: AtomS3R-M12 docs and
// the M5Stack ESPHome example, which agree exactly. See
// doc/m12-camera-firmware.md. These GPIO are disjoint from the Echo Base audio
// pins {5,6,7,8,38,39}, so camera and audio coexist with no remapping.
// PWDN and RESET are intentionally -1. M5Stack's own working AtomS3R-M12
// camera config (ESPHome example) leaves both unset: the OV3660 powers up via
// hardware default, with no software power-down line. Driving GPIO18 as PWDN
// made esp_camera_init's sensor probe fail with 0x105 (ESP_ERR_NOT_FOUND).
constexpr int kPinPwdn = -1;
constexpr int kPinReset = -1;  // no dedicated reset line; SCCB soft reset
constexpr int kPinXclk = 21;
constexpr int kPinSccbSda = 12;
constexpr int kPinSccbScl = 9;
constexpr int kPinD0 = 3;
constexpr int kPinD1 = 42;
constexpr int kPinD2 = 46;
constexpr int kPinD3 = 48;
constexpr int kPinD4 = 4;
constexpr int kPinD5 = 17;
constexpr int kPinD6 = 11;
constexpr int kPinD7 = 13;
constexpr int kPinVsync = 10;
constexpr int kPinHref = 14;
constexpr int kPinPclk = 40;

// QXGA (2048x1536) = the OV3660's native full 3MP. begin() steps fb_count down
// if PSRAM can't hold it. ?full=1 is then a no-op (already at max).
constexpr framesize_t kBaseFrameSize = FRAMESIZE_QXGA;
constexpr framesize_t kFullFrameSize = FRAMESIZE_QXGA;

bool timingSafeEquals(const String& a, const String& b) {
  if (a.length() != b.length()) {
    return false;
  }
  uint8_t diff = 0;
  for (size_t i = 0; i < a.length(); ++i) {
    diff |= static_cast<uint8_t>(a.charAt(i)) ^ static_cast<uint8_t>(b.charAt(i));
  }
  return diff == 0;
}

String bearerToken(const String& authorization) {
  if (!authorization.startsWith("Bearer ")) {
    return String();
  }
  String token = authorization.substring(7);
  token.trim();
  return token;
}

}  // namespace

bool HeadroomCamera::begin() {
  camera_config_t cfg = {};
  cfg.pin_pwdn = kPinPwdn;
  cfg.pin_reset = kPinReset;
  cfg.pin_xclk = kPinXclk;
  cfg.pin_sccb_sda = kPinSccbSda;
  cfg.pin_sccb_scl = kPinSccbScl;
  // The bundled esp32-camera is compiled with CONFIG_SCCB_HARDWARE_I2C_PORT1=y,
  // so the OV3660 SCCB always uses hardware I2C port 1 (cfg.sccb_i2c_port is
  // ignored once pins are set). Set it anyway to document the port.
  cfg.sccb_i2c_port = 1;
  cfg.pin_d0 = kPinD0;
  cfg.pin_d1 = kPinD1;
  cfg.pin_d2 = kPinD2;
  cfg.pin_d3 = kPinD3;
  cfg.pin_d4 = kPinD4;
  cfg.pin_d5 = kPinD5;
  cfg.pin_d6 = kPinD6;
  cfg.pin_d7 = kPinD7;
  cfg.pin_vsync = kPinVsync;
  cfg.pin_href = kPinHref;
  cfg.pin_pclk = kPinPclk;
  cfg.xclk_freq_hz = 20000000;
  // XCLK is generated via LEDC. The M12 has no LCD backlight, so timer/channel
  // 0 are free; audio uses I2S, not LEDC.
  cfg.ledc_timer = LEDC_TIMER_0;
  cfg.ledc_channel = LEDC_CHANNEL_0;
  cfg.pixel_format = PIXFORMAT_JPEG;
  cfg.frame_size = kBaseFrameSize;
  cfg.jpeg_quality = 12;  // 10..14 reasonable; lower = better quality, larger
  cfg.fb_count = 2;
  cfg.fb_location = CAMERA_FB_IN_PSRAM;  // 8MB PSRAM present
  cfg.grab_mode = CAMERA_GRAB_LATEST;

  // M5Unified's In_I2C (internal IMU/sensor bus) sits on hardware I2C port 1 on
  // the ESP32-S3 — the same port esp32-camera's SCCB hard-codes — so
  // esp_camera_init's i2c_driver_install(port 1) fails with "sccb init err" /
  // probe 0xffffffff. The M12 does not use the IMU (cfg.internal_imu=false), so
  // release the internal bus to free port 1. The Echo Base audio (ES8311) lives
  // on Ex_I2C / port 0 and is untouched.
  M5.In_I2C.release();

  esp_err_t err = esp_camera_init(&cfg);
  if (err != ESP_OK) {
    // QXGA with fb_count=2 may exhaust PSRAM; retry with a single buffer, then
    // fall back to UXGA, so we still get the largest frame the board can hold.
    esp_camera_deinit();
    cfg.fb_count = 1;
    cfg.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
    err = esp_camera_init(&cfg);
  }
  if (err != ESP_OK) {
    esp_camera_deinit();
    cfg.frame_size = FRAMESIZE_UXGA;
    cfg.fb_count = 2;
    cfg.grab_mode = CAMERA_GRAB_LATEST;
    err = esp_camera_init(&cfg);
  }
  last_err_ = static_cast<int>(err);
  if (err != ESP_OK) {
    Serial.printf("camera init failed: 0x%x\n", err);
    ready_ = false;
    return false;
  }
  ready_ = true;
  Serial.printf("camera fb_count=%d frame_size=%d\n", cfg.fb_count, cfg.frame_size);
  // Crisper text for OCR: bump sharpness, drop denoise smear, nudge contrast.
  // Guard each function pointer (not all are implemented per sensor).
  sensor_t* s = esp_camera_sensor_get();
  if (s != nullptr) {
    if (s->set_sharpness) s->set_sharpness(s, 3);
    if (s->set_denoise) s->set_denoise(s, 0);
    if (s->set_contrast) s->set_contrast(s, 1);
    // Orientation: with the device held USB-port-down, the raw OV3660 frame is
    // left-right mirrored and rotated 90deg. The sensor can undo the mirror in
    // hardware (free) but cannot rotate, so /snapshot is non-mirrored and a
    // consumer must rotate it 90deg CCW for upright. (hmirror=1 + rotate-CCW is
    // identical to rotating the raw frame 90deg CW then mirroring.)
    if (s->set_hmirror) s->set_hmirror(s, 1);
  }
  Serial.println("camera init ok (OV3660, QXGA JPEG, hmirror=1)");
  return true;
}

void HeadroomCamera::registerRoutes(WebServer& server, const String& authToken) {
  server_ = &server;
  authToken_ = authToken;
  server.on("/snapshot", HTTP_GET, [this]() { handleSnapshot(); });
  server.on("/camera", HTTP_GET, [this]() { handleStatus(); });
  server.on("/camera/tune", HTTP_GET, [this]() { handleTune(); });
  server.on("/audiotest", HTTP_GET, [this]() { handleAudioTest(); });
  Serial.println("camera routes registered: GET /snapshot[?full=1], GET /camera, GET /camera/tune, GET /audiotest");
}

void HeadroomCamera::handleStatus() {
  // Unauthenticated diagnostics: report whether the sensor initialised and, if
  // not, the esp_camera_init error code (e.g. 0x105 = ESP_ERR_NOT_FOUND probe
  // failure). Lets the PC side debug the camera over HTTP without serial.
  sensor_t* s = esp_camera_sensor_get();
  unsigned pid = s ? static_cast<unsigned>(s->id.PID) : 0;
  int fs = s ? static_cast<int>(s->status.framesize) : -1;
  int w = (fs >= 0) ? resolution[fs].width : 0;
  int h = (fs >= 0) ? resolution[fs].height : 0;
  char body[200];
  snprintf(body, sizeof(body),
           "{\"ready\":%s,\"error\":%d,\"error_hex\":\"0x%x\",\"pid\":\"0x%x\",\"framesize\":%d,\"width\":%d,\"height\":%d}",
           ready_ ? "true" : "false", last_err_, static_cast<unsigned>(last_err_), pid, fs, w, h);
  server_->sendHeader("Access-Control-Allow-Origin", "*");
  server_->send(200, "application/json", body);
}

void HeadroomCamera::handleTune() {
  // Live OCR tuning without a reflash: apply any provided query params to the
  // sensor and report the resulting status. Unauthenticated diagnostics.
  sensor_t* s = esp_camera_sensor_get();
  if (s == nullptr) {
    server_->send(503, "application/json", F("{\"ok\":false,\"error\":\"no_sensor\"}"));
    return;
  }
  if (s->set_sharpness && server_->hasArg("sharpness")) s->set_sharpness(s, server_->arg("sharpness").toInt());
  if (s->set_denoise && server_->hasArg("denoise")) s->set_denoise(s, server_->arg("denoise").toInt());
  if (s->set_contrast && server_->hasArg("contrast")) s->set_contrast(s, server_->arg("contrast").toInt());
  if (s->set_brightness && server_->hasArg("brightness")) s->set_brightness(s, server_->arg("brightness").toInt());
  if (s->set_saturation && server_->hasArg("saturation")) s->set_saturation(s, server_->arg("saturation").toInt());
  if (s->set_quality && server_->hasArg("quality")) s->set_quality(s, server_->arg("quality").toInt());
  // hmirror (left-right) and vflip (up-down) are done in the OV3660 hardware
  // (free, no CPU). A 90deg rotation is NOT possible on the sensor and must be
  // handled by the consumer; only mirror/flip live here.
  if (s->set_hmirror && server_->hasArg("hmirror")) s->set_hmirror(s, server_->arg("hmirror").toInt());
  if (s->set_vflip && server_->hasArg("vflip")) s->set_vflip(s, server_->arg("vflip").toInt());
  char body[256];
  snprintf(body, sizeof(body),
           "{\"sharpness\":%d,\"denoise\":%d,\"contrast\":%d,\"brightness\":%d,\"saturation\":%d,\"quality\":%d,\"hmirror\":%d,\"vflip\":%d}",
           s->status.sharpness, s->status.denoise, s->status.contrast,
           s->status.brightness, s->status.saturation, s->status.quality,
           s->status.hmirror, s->status.vflip);
  server_->sendHeader("Access-Control-Allow-Origin", "*");
  server_->send(200, "application/json", body);
}

void HeadroomCamera::handleAudioTest() {
  // M12 audio bring-up diagnostic: report whether M5 thinks a speaker is
  // configured (Echo Base ES8311 detected) and play a test tone so the fault
  // (no-detect vs configured-but-silent) can be localized over HTTP. Params:
  // freq (Hz), ms (duration), vol (0..255). Unauthenticated.
  bool enabledBefore = M5.Speaker.isEnabled();
  uint8_t vol = server_->hasArg("vol") ? static_cast<uint8_t>(server_->arg("vol").toInt()) : 200;
  int freq = server_->hasArg("freq") ? server_->arg("freq").toInt() : 880;
  int ms = server_->hasArg("ms") ? server_->arg("ms").toInt() : 400;
  // Re-init the speaker in case it was left in mic/ADC mode, then play.
  M5.Speaker.begin();
  M5.Speaker.setVolume(vol);
  bool toneOk = M5.Speaker.tone(static_cast<float>(freq), ms);
  int board = static_cast<int>(M5.getBoard());
  bool micEnabled = M5.Mic.isEnabled();
  char body[320];
  snprintf(body, sizeof(body),
           "{\"board\":%d,\"spk_enabled\":%s,\"spk_enabled_before_begin\":%s,"
           "\"mic_enabled\":%s,\"tone_ok\":%s,"
           "\"vol\":%d,\"freq\":%d,\"ms\":%d,\"running\":%s}",
           board,
           M5.Speaker.isEnabled() ? "true" : "false",
           enabledBefore ? "true" : "false",
           micEnabled ? "true" : "false",
           toneOk ? "true" : "false",
           vol, freq, ms, M5.Speaker.isPlaying() ? "true" : "false");
  server_->sendHeader("Access-Control-Allow-Origin", "*");
  server_->send(200, "application/json", body);
}

bool HeadroomCamera::authorized() {
  if (authToken_.length() == 0) {
    return true;
  }
  String queryToken = server_->arg("auth_token");
  if (queryToken.length() == 0) {
    queryToken = server_->arg("token");
  }
  if (queryToken.length() > 0 && timingSafeEquals(queryToken, authToken_)) {
    return true;
  }
  String headerToken = server_->header("X-Headroom-Auth");
  if (headerToken.length() > 0 && timingSafeEquals(headerToken, authToken_)) {
    return true;
  }
  String bearer = bearerToken(server_->header("Authorization"));
  return bearer.length() > 0 && timingSafeEquals(bearer, authToken_);
}

void HeadroomCamera::handleSnapshot() {
  if (!authorized()) {
    server_->send(401, "application/json", F("{\"ok\":false,\"error\":\"unauthorized\"}"));
    return;
  }
  if (!ready_) {
    server_->send(503, "application/json", F("{\"ok\":false,\"error\":\"camera_not_ready\"}"));
    return;
  }

  // ?full=1 raises the sensor to QXGA for one OCR-grade capture. The runtime
  // framebuffer realloc can fail under PSRAM pressure, so on a failed grab we
  // drop back to the base size and retry instead of returning an error.
  bool full = server_->hasArg("full") && server_->arg("full") != "0";
  sensor_t* sensor = esp_camera_sensor_get();
  bool raised = false;
  if (full && sensor != nullptr) {
    if (sensor->set_framesize(sensor, kFullFrameSize) == 0) {
      raised = true;
      camera_fb_t* warm = esp_camera_fb_get();
      if (warm != nullptr) esp_camera_fb_return(warm);
    }
  }

  camera_fb_t* fb = esp_camera_fb_get();
  if (fb == nullptr && raised && sensor != nullptr) {
    // QXGA grab failed; fall back to the base size and retry.
    sensor->set_framesize(sensor, kBaseFrameSize);
    raised = false;
    camera_fb_t* warm = esp_camera_fb_get();
    if (warm != nullptr) esp_camera_fb_return(warm);
    fb = esp_camera_fb_get();
  }
  if (fb == nullptr) {
    server_->send(500, "application/json", F("{\"ok\":false,\"error\":\"capture_failed\"}"));
    return;
  }

  server_->setContentLength(fb->len);
  server_->sendHeader("Access-Control-Allow-Origin", "*");
  server_->sendHeader("Cache-Control", "no-store");
  server_->send(200, "image/jpeg", "");
  server_->client().write(fb->buf, fb->len);

  esp_camera_fb_return(fb);
  if (raised && sensor != nullptr) {
    sensor->set_framesize(sensor, kBaseFrameSize);
  }
}

#endif  // HEADROOM_M12
