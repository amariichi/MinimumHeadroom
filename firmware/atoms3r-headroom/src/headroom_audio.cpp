#include "headroom_audio.h"

#include <HTTPClient.h>
#include <M5Unified.h>
#include <WiFiClient.h>
#include <mbedtls/base64.h>
#include <string.h>

namespace {

constexpr size_t kWavHeaderProbeBytes = 96;

uint32_t readLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) | (static_cast<uint32_t>(data[2]) << 16) |
         (static_cast<uint32_t>(data[3]) << 24);
}

uint16_t readLe16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
}

bool startsWithHttp(const String& url) {
  return url.startsWith("http://") || url.startsWith("https://");
}

}  // namespace

void HeadroomAudio::begin(const HeadroomSettingsData& settings) {
  httpBase_ = settings.faceHttpBase;
  authToken_ = settings.authToken;
  maxBase64Seconds_ = max(1, min(15, settings.maxBase64TtsSeconds));
  maxHttpBytes_ = max(100000, settings.maxHttpTtsBytes);
  M5.Speaker.setVolume(130);
  M5.Speaker.begin();
}

void HeadroomAudio::loop() {
  releaseActive();
}

void HeadroomAudio::stop() {
  M5.Speaker.stop();
  releaseActive();
}

bool HeadroomAudio::busy() const {
  return M5.Speaker.isPlaying();
}

HeadroomAudioResult HeadroomAudio::playBase64Wav(const char* audioBase64, size_t base64Length, int sampleRateHint) {
  if (!audioBase64 || base64Length == 0) {
    return HeadroomAudioResult::Ignored;
  }

  size_t decodedCapacity = ((base64Length * 3) / 4) + 8;
  size_t roughLimit = static_cast<size_t>(maxBase64Seconds_) * static_cast<size_t>(sampleRateHint > 0 ? sampleRateHint : 24000) * 2 + 128;
  if (decodedCapacity > roughLimit) {
    Serial.printf("tts_audio too large before decode base64=%u decoded~=%u limit=%u\n", static_cast<unsigned>(base64Length),
                  static_cast<unsigned>(decodedCapacity), static_cast<unsigned>(roughLimit));
    return HeadroomAudioResult::TooLarge;
  }

  uint8_t* wav = static_cast<uint8_t*>(ps_malloc(decodedCapacity));
  if (!wav) {
    wav = static_cast<uint8_t*>(malloc(decodedCapacity));
  }
  if (!wav) {
    return HeadroomAudioResult::DecodeFailed;
  }

  size_t decodedLength = 0;
  int rc = mbedtls_base64_decode(wav, decodedCapacity, &decodedLength, reinterpret_cast<const unsigned char*>(audioBase64), base64Length);
  if (rc != 0 || decodedLength == 0) {
    free(wav);
    Serial.printf("base64 decode failed rc=%d\n", rc);
    return HeadroomAudioResult::DecodeFailed;
  }

  int sampleRate = 0;
  size_t dataBytes = 0;
  uint16_t bits = 0;
  uint16_t channels = 0;
  if (!inspectWav(wav, decodedLength, &sampleRate, &dataBytes, &bits, &channels)) {
    free(wav);
    return HeadroomAudioResult::Unsupported;
  }
  if (bits != 16 || channels != 1) {
    Serial.printf("unsupported wav format bits=%u channels=%u\n", bits, channels);
    free(wav);
    return HeadroomAudioResult::Unsupported;
  }
  size_t maxDataBytes = static_cast<size_t>(maxBase64Seconds_) * static_cast<size_t>(sampleRate) * 2;
  if (dataBytes > maxDataBytes) {
    free(wav);
    return HeadroomAudioResult::TooLarge;
  }

  return playOwnedWav(wav, decodedLength, true);
}

HeadroomAudioResult HeadroomAudio::playHttpWavRef(const String& url) {
  String fullUrl = absoluteUrl(url);
  if (!startsWithHttp(fullUrl)) {
    return HeadroomAudioResult::Unsupported;
  }

  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, fullUrl)) {
    return HeadroomAudioResult::HttpFailed;
  }
  if (authToken_.length() > 0) {
    http.addHeader("Authorization", String("Bearer ") + authToken_);
  }

  int status = http.GET();
  if (status != HTTP_CODE_OK) {
    Serial.printf("tts_audio_ref http status=%d\n", status);
    http.end();
    return HeadroomAudioResult::HttpFailed;
  }

  int contentLength = http.getSize();
  if (contentLength <= 0 || contentLength > maxHttpBytes_) {
    Serial.printf("tts_audio_ref size rejected length=%d limit=%d\n", contentLength, maxHttpBytes_);
    http.end();
    return HeadroomAudioResult::TooLarge;
  }

  uint8_t* wav = static_cast<uint8_t*>(ps_malloc(contentLength));
  if (!wav) {
    wav = static_cast<uint8_t*>(malloc(contentLength));
  }
  if (!wav) {
    http.end();
    return HeadroomAudioResult::DecodeFailed;
  }

  WiFiClient* stream = http.getStreamPtr();
  size_t offset = 0;
  while (http.connected() && offset < static_cast<size_t>(contentLength)) {
    int available = stream->available();
    if (available <= 0) {
      delay(1);
      continue;
    }
    int remaining = contentLength - static_cast<int>(offset);
    int readLen = stream->readBytes(wav + offset, min(available, remaining));
    if (readLen <= 0) {
      break;
    }
    offset += static_cast<size_t>(readLen);
  }
  http.end();

  if (offset != static_cast<size_t>(contentLength)) {
    free(wav);
    Serial.printf("tts_audio_ref incomplete read got=%u expected=%u\n", static_cast<unsigned>(offset), static_cast<unsigned>(contentLength));
    return HeadroomAudioResult::HttpFailed;
  }

  int sampleRate = 0;
  size_t dataBytes = 0;
  uint16_t bits = 0;
  uint16_t channels = 0;
  if (!inspectWav(wav, offset, &sampleRate, &dataBytes, &bits, &channels) || bits != 16 || channels != 1) {
    free(wav);
    return HeadroomAudioResult::Unsupported;
  }

  return playOwnedWav(wav, offset, true);
}

HeadroomAudioResult HeadroomAudio::playWavBytes(const uint8_t* wav, size_t length) {
  if (!wav || length == 0) {
    return HeadroomAudioResult::Ignored;
  }
  if (length > static_cast<size_t>(maxHttpBytes_)) {
    return HeadroomAudioResult::TooLarge;
  }

  int sampleRate = 0;
  size_t dataBytes = 0;
  uint16_t bits = 0;
  uint16_t channels = 0;
  if (!inspectWav(wav, length, &sampleRate, &dataBytes, &bits, &channels) || bits != 16 || channels != 1) {
    return HeadroomAudioResult::Unsupported;
  }

  uint8_t* owned = static_cast<uint8_t*>(ps_malloc(length));
  if (!owned) {
    owned = static_cast<uint8_t*>(malloc(length));
  }
  if (!owned) {
    return HeadroomAudioResult::DecodeFailed;
  }
  memcpy(owned, wav, length);
  return playOwnedWav(owned, length, true);
}

void HeadroomAudio::releaseActive() {
  if (!activeWav_) {
    return;
  }
  if (!M5.Speaker.isPlaying()) {
    free(activeWav_);
    activeWav_ = nullptr;
    activeWavLength_ = 0;
  }
}

HeadroomAudioResult HeadroomAudio::playOwnedWav(uint8_t* wav, size_t length, bool takeOwnership) {
  releaseActive();
  M5.Speaker.stop();
  if (activeWav_) {
    free(activeWav_);
    activeWav_ = nullptr;
    activeWavLength_ = 0;
  }

  bool ok = M5.Speaker.playWav(wav, length, 1, -1, true);
  if (!ok) {
    if (takeOwnership) {
      free(wav);
    }
    return HeadroomAudioResult::PlaybackFailed;
  }

  if (takeOwnership) {
    activeWav_ = wav;
    activeWavLength_ = length;
  }
  return HeadroomAudioResult::Ok;
}

bool HeadroomAudio::inspectWav(const uint8_t* wav, size_t length, int* sampleRate, size_t* dataBytes, uint16_t* bitsPerSample, uint16_t* channels) {
  if (!wav || length < 44 || memcmp(wav, "RIFF", 4) != 0 || memcmp(wav + 8, "WAVE", 4) != 0) {
    return false;
  }

  bool sawFmt = false;
  bool sawData = false;
  size_t offset = 12;
  while (offset + 8 <= min(length, kWavHeaderProbeBytes)) {
    const uint8_t* chunk = wav + offset;
    uint32_t chunkSize = readLe32(chunk + 4);
    size_t chunkStart = offset + 8;
    if (chunkStart + chunkSize > length) {
      return false;
    }

    if (memcmp(chunk, "fmt ", 4) == 0 && chunkSize >= 16) {
      uint16_t audioFormat = readLe16(wav + chunkStart);
      *channels = readLe16(wav + chunkStart + 2);
      *sampleRate = static_cast<int>(readLe32(wav + chunkStart + 4));
      *bitsPerSample = readLe16(wav + chunkStart + 14);
      sawFmt = audioFormat == 1;
    } else if (memcmp(chunk, "data", 4) == 0) {
      *dataBytes = chunkSize;
      sawData = true;
      break;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  return sawFmt && sawData && *sampleRate > 0 && *dataBytes > 0;
}

String HeadroomAudio::absoluteUrl(const String& url) const {
  if (startsWithHttp(url)) {
    return url;
  }
  if (!url.startsWith("/")) {
    return url;
  }
  String base = httpBase_;
  if (base.endsWith("/")) {
    base.remove(base.length() - 1);
  }
  return base + url;
}
