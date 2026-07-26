#include "headroom_setup_portal.h"

namespace {

constexpr byte kDnsPort = 53;

String htmlEscape(const String& input) {
  String escaped;
  escaped.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); ++i) {
    char c = input.charAt(i);
    switch (c) {
      case '&':
        escaped += F("&amp;");
        break;
      case '<':
        escaped += F("&lt;");
        break;
      case '>':
        escaped += F("&gt;");
        break;
      case '"':
        escaped += F("&quot;");
        break;
      default:
        escaped += c;
        break;
    }
  }
  return escaped;
}

String selectedIf(bool selected) {
  return selected ? F(" selected") : String();
}

String checkedIf(bool checked) {
  return checked ? F(" checked") : String();
}

int requestInt(WebServer& server, const char* name, int fallback) {
  if (!server.hasArg(name)) {
    return fallback;
  }
  return server.arg(name).toInt();
}

float requestFloat(WebServer& server, const char* name, float fallback) {
  if (!server.hasArg(name)) {
    return fallback;
  }
  return server.arg(name).toFloat();
}

}  // namespace

HeadroomSetupPortal::HeadroomSetupPortal(HeadroomSettings& settings)
    : settings_(settings), server_(80) {}

bool HeadroomSetupPortal::begin() {
  uint64_t mac = ESP.getEfuseMac();
  char macBuf[18];
  snprintf(macBuf, sizeof(macBuf), "%02X:%02X:%02X:%02X:%02X:%02X",
           static_cast<unsigned>((mac >> 40) & 0xFF),
           static_cast<unsigned>((mac >> 32) & 0xFF),
           static_cast<unsigned>((mac >> 24) & 0xFF),
           static_cast<unsigned>((mac >> 16) & 0xFF),
           static_cast<unsigned>((mac >> 8) & 0xFF),
           static_cast<unsigned>(mac & 0xFF));
  macAddress_ = macBuf;
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%04X", static_cast<unsigned>(mac & 0xFFFF));
  ssid_ = String("RMH-SETUP-") + suffix;

  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(ssid_.c_str())) {
    return false;
  }

  IPAddress apIp = WiFi.softAPIP();
  dns_.start(kDnsPort, "*", apIp);

  server_.on("/", HTTP_GET, [this]() { handleRoot(); });
  server_.on("/save", HTTP_POST, [this]() { handleSave(); });
  server_.onNotFound([this]() { handleNotFound(); });
  server_.begin();
  active_ = true;
  return true;
}

void HeadroomSetupPortal::handleClient() {
  if (!active_) {
    return;
  }
  dns_.processNextRequest();
  server_.handleClient();
}

bool HeadroomSetupPortal::active() const {
  return active_;
}

const String& HeadroomSetupPortal::ssid() const {
  return ssid_;
}

IPAddress HeadroomSetupPortal::ip() const {
  return WiFi.softAPIP();
}

void HeadroomSetupPortal::handleRoot() {
  server_.send(200, "text/html; charset=utf-8", renderPage(String()));
}

void HeadroomSetupPortal::handleSave() {
  HeadroomSettingsData next = settingsFromRequest();
  if (!settings_.save(next)) {
    server_.send(500, "text/html; charset=utf-8", renderPage("Save failed. Check serial logs."));
    return;
  }
  server_.send(200, "text/html; charset=utf-8", renderPage("Saved. Restart the Atom to use the new settings."));
}

void HeadroomSetupPortal::handleNotFound() {
  server_.sendHeader("Location", "/", true);
  server_.send(302, "text/plain", "");
}

String HeadroomSetupPortal::renderPage(const String& message) {
  const HeadroomSettingsData& data = settings_.data();
  String pose = HeadroomSettings::placementPoseName(data.placementPose);
  String html;
  html.reserve(6800);
  html += F("<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>");
  html += F("<title>RMH Atom Setup</title><style>");
  html += F("body{font-family:system-ui,sans-serif;margin:0;background:#17191d;color:#f4f5f6}");
  html += F("main{max-width:680px;margin:auto;padding:20px}label{display:block;margin:14px 0 6px}");
  html += F("input,select{box-sizing:border-box;width:100%;padding:10px;border-radius:6px;border:1px solid #59606b;background:#22262d;color:#fff}");
  html += F("button{margin-top:18px;padding:11px 16px;border:0;border-radius:6px;background:#54b6ff;color:#071018;font-weight:700}");
  html += F(".row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.msg{padding:10px;background:#26364a;border-left:4px solid #54b6ff}");
  html += F("@media(max-width:560px){.row{grid-template-columns:1fr}}</style></head><body><main>");
  html += F("<h1>RMH Atom Setup</h1>");
  html += F("<p class='msg'>Atom MAC: ");
  html += htmlEscape(macAddress_);
  html += F("<br>Setup AP SSID: ");
  html += htmlEscape(ssid_);
  html += F("<br>Setup AP IP: ");
  html += ip().toString();
  html += F("</p>");
  if (message.length() > 0) {
    html += F("<p class='msg'>");
    html += htmlEscape(message);
    html += F("</p>");
  }
  html += F("<form method='post' action='/save'>");
  html += F("<label>Wi-Fi SSID</label><input name='ssid' value='");
  html += htmlEscape(data.wifiSsid);
  html += F("' autocomplete='off'>");
  html += F("<label>Wi-Fi password</label><input name='wifi_pw' type='password' value='");
  html += htmlEscape(data.wifiPassword);
  html += F("'>");
  html += F("<label>Wi-Fi SSID 2 (optional, tried after #1)</label><input name='ssid2' value='");
  html += htmlEscape(data.wifiSsid2);
  html += F("' autocomplete='off'>");
  html += F("<label>Wi-Fi password 2</label><input name='wifi_pw2' type='password' value='");
  html += htmlEscape(data.wifiPassword2);
  html += F("'>");
  html += F("<label>Wi-Fi SSID 3 (optional, tried after #2)</label><input name='ssid3' value='");
  html += htmlEscape(data.wifiSsid3);
  html += F("' autocomplete='off'>");
  html += F("<label>Wi-Fi password 3</label><input name='wifi_pw3' type='password' value='");
  html += htmlEscape(data.wifiPassword3);
  html += F("'>");
  html += F("<label>Face HTTP base</label><input name='http_base' value='");
  html += htmlEscape(data.faceHttpBase);
  html += F("'>");
  html += F("<label>Face WebSocket URL</label><input name='ws_url' value='");
  html += htmlEscape(data.faceWsUrl);
  html += F("'>");
  html += F("<label>PC mDNS host (optional, e.g. my-pc.local — auto-tracks the PC's LAN IP)</label><input name='mdns_host' value='");
  html += htmlEscape(data.mdnsHost);
  html += F("' autocomplete='off'>");
  html += F("<label>Auth token</label><input name='auth' type='password' value='");
  html += htmlEscape(data.authToken);
  html += F("'>");
  html += F("<label>Device ID</label><input name='device_id' value='");
  html += htmlEscape(data.deviceId);
  html += F("'>");
  html += F("<label>Display priority agent ID</label><input name='display_id' value='");
  html += htmlEscape(data.displayAgentId);
  html += F("'>");
  html += F("<label>Input target agent ID</label><input name='input_id' value='");
  html += htmlEscape(data.inputTargetAgentId);
  html += F("'>");
  html += F("<label>ASR language</label><select name='asr_lang'>");
  html += F("<option value='ja'");
  html += selectedIf(data.asrLanguage == "ja");
  html += F(">Japanese</option>");
  html += F("<option value='en'");
  html += selectedIf(data.asrLanguage == "en");
  html += F(">English</option>");
  html += F("</select>");
  html += F("<label><input name='vad_on' type='checkbox' value='1'");
  html += checkedIf(data.continuousVadEnabled);
  html += F("> Continuous hands-free VAD</label>");
  html += F("<label>Firmware VAD RMS threshold (0=Silero mode, ~0.025 for RMS backend)</label>");
  html += F("<input name='vad_rms' type='number' min='0' max='1' step='0.001' value='");
  html += String(data.vadFirmwareRms, 4);
  html += F("'>");
  html += F("<label>VAD speech tail frames (0-240; 8 ≈ 0.5s; carries speech decay)</label>");
  html += F("<input name='vad_tail' type='number' min='0' max='240' step='1' value='");
  html += String(data.vadSpeechTailFrames);
  html += F("'>");
  html += F("<label>Post-playback VAD cooldown (200-5000 ms; 1200 is conservative)</label>");
  html += F("<input name='vad_playback_cooldown_ms' type='number' min='200' max='5000' step='1' value='");
  html += String(data.vadPlaybackCooldownMs);
  html += F("'>");
  html += F("<label>Speaker volume (0-200; faced indoor 112, outdoor starting point 160)</label>");
  html += F("<input name='speaker_volume' type='number' min='0' max='200' step='1' value='");
  html += String(data.speakerVolume);
  html += F("'>");
  html += F("<label>VAD audio encoding</label><select name='vad_enc'>");
  html += F("<option value='ima_adpcm'");
  html += selectedIf(data.vadEncoding == "ima_adpcm");
  html += F(">ima_adpcm (default, 4:1 lossy, ~40 MB/h)</option>");
  html += F("<option value='pcm16'");
  html += selectedIf(data.vadEncoding == "pcm16");
  html += F(">pcm16 (compatibility, raw 16-bit, ~160 MB/h)</option>");
  html += F("</select>");
  html += F("<div class='row'><div><label>Max base64 TTS seconds</label><input name='max_b64_sec' type='number' min='1' max='15' value='");
  html += String(data.maxBase64TtsSeconds);
  html += F("'></div><div><label>Max HTTP TTS bytes</label><input name='max_http_b' type='number' min='100000' max='3000000' value='");
  html += String(data.maxHttpTtsBytes);
  html += F("'></div></div>");
  html += F("<div class='row'><div><label>Face rotation</label><select name='rotation'>");
  for (int rotation : {0, 90, 180, 270}) {
    html += F("<option value='");
    html += String(rotation);
    html += F("'");
    html += selectedIf(data.faceRotationDegrees == rotation);
    html += F(">");
    html += String(rotation);
    html += F(" degrees</option>");
  }
  html += F("</select></div><div><label>Placement pose</label><select name='pose'>");
  html += F("<option value='screen_up'");
  html += selectedIf(pose == "screen_up");
  html += F(">screen faces upward</option>");
  html += F("<option value='side_up'");
  html += selectedIf(pose == "side_up");
  html += F(">screen faces sideways</option>");
  html += F("</select></div></div>");
  html += F("<label>Upper side / face top</label><select name='up_side'>");
  for (int side : {0, 90, 180, 270}) {
    html += F("<option value='");
    html += String(side);
    html += F("'");
    html += selectedIf(data.upSideDegrees == side);
    html += F(">side ");
    html += String(side);
    html += F(" / face top ");
    html += String(side);
    html += F("</option>");
  }
  html += F("</select><button type='submit'>Save Settings</button></form>");
  html += F("</main></body></html>");
  return html;
}

HeadroomSettingsData HeadroomSetupPortal::settingsFromRequest() {
  HeadroomSettingsData next = settings_.editable();
  next.wifiSsid = server_.arg("ssid");
  next.wifiPassword = server_.arg("wifi_pw");
  next.wifiSsid2 = server_.arg("ssid2");
  next.wifiPassword2 = server_.arg("wifi_pw2");
  next.wifiSsid3 = server_.arg("ssid3");
  next.wifiPassword3 = server_.arg("wifi_pw3");
  next.faceHttpBase = server_.arg("http_base");
  next.faceWsUrl = server_.arg("ws_url");
  next.mdnsHost = server_.arg("mdns_host");
  next.authToken = server_.arg("auth");
  next.deviceId = server_.arg("device_id");
  next.displayAgentId = server_.arg("display_id");
  next.inputTargetAgentId = server_.arg("input_id");
  next.asrLanguage = HeadroomSettings::normalizeAsrLanguage(server_.arg("asr_lang"), next.asrLanguage);
  next.continuousVadEnabled = server_.hasArg("vad_on");
  next.vadFirmwareRms = requestFloat(server_, "vad_rms", next.vadFirmwareRms);
  if (next.vadFirmwareRms < 0.0f) {
    next.vadFirmwareRms = 0.0f;
  } else if (next.vadFirmwareRms > 1.0f) {
    next.vadFirmwareRms = 1.0f;
  }
  next.vadEncoding = HeadroomSettings::normalizeVadEncoding(server_.arg("vad_enc"), next.vadEncoding);
  next.vadSpeechTailFrames = requestInt(server_, "vad_tail", next.vadSpeechTailFrames);
  if (next.vadSpeechTailFrames < 0) {
    next.vadSpeechTailFrames = 0;
  } else if (next.vadSpeechTailFrames > 240) {
    next.vadSpeechTailFrames = 240;
  }
  next.vadPlaybackCooldownMs = HeadroomSettings::normalizeVadPlaybackCooldownMs(
      requestInt(server_, "vad_playback_cooldown_ms", next.vadPlaybackCooldownMs));
  next.speakerVolume = HeadroomSettings::normalizeSpeakerVolume(
      requestInt(server_, "speaker_volume", next.speakerVolume));
  next.maxBase64TtsSeconds = requestInt(server_, "max_b64_sec", next.maxBase64TtsSeconds);
  next.maxHttpTtsBytes = requestInt(server_, "max_http_b", next.maxHttpTtsBytes);
  next.faceRotationDegrees = HeadroomSettings::normalizeRotation(requestInt(server_, "rotation", next.faceRotationDegrees));
  next.placementPose = HeadroomSettings::parsePlacementPose(server_.arg("pose"));
  next.upSideDegrees = HeadroomSettings::normalizeRotation(requestInt(server_, "up_side", next.upSideDegrees));
  return next;
}
