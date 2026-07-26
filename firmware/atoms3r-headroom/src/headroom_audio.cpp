#include "headroom_audio.h"

#include <HTTPClient.h>
#include <M5Unified.h>
#include <WiFiClient.h>
#include <mbedtls/base64.h>
#include <math.h>
#include <string.h>

#include "ima_adpcm.h"

namespace {

constexpr int kMinPlaybackSampleRate = 8000;
constexpr int kMaxPlaybackSampleRate = 48000;
constexpr size_t kMaxDecodedPcmBytes = 1200000;
constexpr uint32_t kHttpReadStallTimeoutMs = 8000;
constexpr uint32_t kMaxSafeRms = 18000;
constexpr uint16_t kNearClipSample = 32600;
constexpr uint8_t kNearClipPercentLimit = 15;

uint32_t readLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) | (static_cast<uint32_t>(data[2]) << 16) |
         (static_cast<uint32_t>(data[3]) << 24);
}

uint16_t readLe16(const uint8_t* data) {
  return static_cast<uint16_t>(data[0]) | (static_cast<uint16_t>(data[1]) << 8);
}

void writeLe16(uint8_t* data, uint16_t value) {
  data[0] = static_cast<uint8_t>(value & 0xff);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xff);
}

void writeLe32(uint8_t* data, uint32_t value) {
  data[0] = static_cast<uint8_t>(value & 0xff);
  data[1] = static_cast<uint8_t>((value >> 8) & 0xff);
  data[2] = static_cast<uint8_t>((value >> 16) & 0xff);
  data[3] = static_cast<uint8_t>((value >> 24) & 0xff);
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
  speakerVolume_ = static_cast<uint8_t>(
      HeadroomSettings::normalizeSpeakerVolume(settings.speakerVolume));
  beginSpeaker();
}

void HeadroomAudio::loop() {
  releaseActive();
  if (recording_ || M5.Speaker.isPlaying() || activeWav_) {
    return;
  }

  QueuedWav next;
  while (popQueuedWav(&next)) {
    HeadroomAudioResult result = startOwnedWavNow(next.data, next.length, true);
    if (result == HeadroomAudioResult::Ok) {
      return;
    }
    Serial.printf("queued wav playback failed result=%d\n", static_cast<int>(result));
  }
}

void HeadroomAudio::stop() {
  M5.Speaker.stop();
  releaseActive();
  releaseQueued();
}

void HeadroomAudio::playCueTone(uint16_t freqHz, uint32_t ms) {
  // Never drive the DAC once the codec is (or is about to be) in mic mode.
  if (recording_) {
    return;
  }
  // Stop any in-flight TTS chunk so the cue is a clean, short beep and the
  // codec is quiescent before the mic window opens.
  M5.Speaker.stop();
  releaseActive();
  releaseQueued();
  beginSpeaker();
  const uint8_t cueVolume = speakerVolume_ > 1 ? speakerVolume_ / 2 : 1;
  M5.Speaker.setVolume(cueVolume);
  M5.Speaker.tone(freqHz, ms);

  // Synchronously wait for the tone to finish AND drain before returning, so
  // the caller can immediately switch the ES8311 to ADC safely.
  uint32_t startedMs = millis();
  while (M5.Speaker.isPlaying() && millis() - startedMs < ms + 250) {
    M5.update();
    delay(5);
  }
  M5.Speaker.stop();
  delay(40);
}

void HeadroomAudio::stopForRecording() {
  // Inhibit all DAC playback first: the ES8311 is about to be reconfigured
  // to ADC/mic mode and any playWav during that window latches it.
  recording_ = true;
  stop();
  M5.Speaker.end();
}

void HeadroomAudio::restoreAfterRecording() {
  // Force a full speaker re-init: M5.Speaker.begin() alone is a no-op if it
  // thinks it is already started, so the ES8311 can stay stuck in the
  // mic/ADC configuration. end() -> begin() reconfigures it back to DAC.
  resetSpeaker();
  recording_ = false;
}

bool HeadroomAudio::busy() const {
  return M5.Speaker.isPlaying() || queuedWavCount_ > 0;
}

void HeadroomAudio::setSpeakerVolume(uint8_t volume) {
  speakerVolume_ = static_cast<uint8_t>(
      HeadroomSettings::normalizeSpeakerVolume(volume));
  // During mic capture the shared ES8311 is in ADC mode. Remember the new
  // value now and let restoreAfterRecording()->beginSpeaker() apply it.
  if (!recording_) {
    M5.Speaker.setVolume(speakerVolume_);
  }
}


float HeadroomAudio::currentMouthOpen() {
  uint32_t nowMs = millis();
  float level = -1.0f;

  if (mouthPcm_ && mouthSampleCount_ > 0 && mouthSampleRate_ > 0 && M5.Speaker.isPlaying()) {
    // playRaw() returns before the codec actually emits sound; shift the
    // sample window slightly later in audio time so the lips do not lead.
    constexpr uint32_t kPlaybackLatencyMs = 45;
    uint32_t sinceStart = nowMs - mouthPlayStartMs_;
    uint32_t elapsedMs = sinceStart > kPlaybackLatencyMs ? sinceStart - kPlaybackLatencyMs : 0;
    size_t center = static_cast<size_t>(
        (static_cast<uint64_t>(elapsedMs) * static_cast<uint64_t>(mouthSampleRate_)) / 1000ULL);
    if (center >= mouthSampleCount_) {
      center = mouthSampleCount_ - 1;
    }

    // Match the worker's _estimate_mouth_open(): RMS over a ~25 ms window,
    // then pow(rms * 3.8, 0.75), so the look stays identical.
    size_t halfWindow = static_cast<size_t>(max(1, mouthSampleRate_ / 80));
    size_t start = center > halfWindow ? center - halfWindow : 0;
    size_t end = min(mouthSampleCount_, center + halfWindow);
    if (end > start) {
      double sumSquares = 0.0;
      for (size_t i = start; i < end; ++i) {
        float s = static_cast<float>(mouthPcm_[i]) / 32768.0f;
        sumSquares += static_cast<double>(s) * static_cast<double>(s);
      }
      float rms = sqrtf(static_cast<float>(sumSquares / static_cast<double>(end - start)));
      level = powf(rms * 3.8f, 0.75f);
      level = level < 0.0f ? 0.0f : (level > 1.0f ? 1.0f : level);
    }
  }

  // While there is real, non-trivial speech energy, track it directly and
  // remember it as the anchor for the release tail.
  if (level >= 0.04f) {
    mouthLastLevel_ = level;
    mouthLastActiveMs_ = nowMs;
    return level;
  }

  // Otherwise glide shut. This covers three early-close causes at once: the
  // codec output latency after isPlaying() drops, the per-chunk fade-out
  // (near-silent tail window), and the brief gap between chunks where
  // isPlaying() is momentarily false. The mouth keeps moving until the sound
  // is genuinely gone instead of snapping closed on any of them.
  constexpr uint32_t kReleaseMs = 220;
  if (mouthLastActiveMs_ != 0) {
    uint32_t since = nowMs - mouthLastActiveMs_;
    if (since < kReleaseMs) {
      return mouthLastLevel_ * (1.0f - static_cast<float>(since) / static_cast<float>(kReleaseMs));
    }
  }
  return 0.0f;
}

bool HeadroomAudio::recording() const {
  return recording_;
}

HeadroomAudioResult HeadroomAudio::playBase64Wav(const char* audioBase64, size_t base64Length, int sampleRateHint) {
  if (recording_) {
    return HeadroomAudioResult::Ignored;  // codec is in mic mode; never play
  }
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

  return playOwnedWav(wav, decodedLength, true);
}

HeadroomAudioResult HeadroomAudio::playHttpWavRef(const String& url) {
  if (recording_) {
    return HeadroomAudioResult::Ignored;  // codec is in mic mode; never play
  }
  String fullUrl = absoluteUrl(url);
  if (!startsWithHttp(fullUrl)) {
    return HeadroomAudioResult::Unsupported;
  }

  HeadroomAudioResult result = fetchAndPlayHttpWavRefOnce(fullUrl);
  if (result != HeadroomAudioResult::HttpFailed) {
    return result;
  }

  // A mobile-tethered Tailnet can briefly drop the first request while routes
  // or radio state settle. Retry the idempotent GET once; audio_id dedupe at
  // ingress/transport prevents a parallel delivery path from playing twice.
  Serial.println("tts_audio_ref retrying after transient HTTP failure");
  delay(80);
  return fetchAndPlayHttpWavRefOnce(fullUrl);
}

HeadroomAudioResult HeadroomAudio::fetchAndPlayHttpWavRefOnce(const String& fullUrl) {
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
  uint32_t lastProgressMs = millis();
  while (http.connected() && offset < static_cast<size_t>(contentLength)) {
    int available = stream->available();
    if (available <= 0) {
      if (millis() - lastProgressMs >= kHttpReadStallTimeoutMs) {
        Serial.println("tts_audio_ref read stalled");
        break;
      }
      delay(1);
      continue;
    }
    int remaining = contentLength - static_cast<int>(offset);
    int readLen = stream->readBytes(wav + offset, min(available, remaining));
    if (readLen <= 0) {
      break;
    }
    offset += static_cast<size_t>(readLen);
    lastProgressMs = millis();
  }
  http.end();

  if (offset != static_cast<size_t>(contentLength)) {
    free(wav);
    Serial.printf("tts_audio_ref incomplete read got=%u expected=%u\n", static_cast<unsigned>(offset), static_cast<unsigned>(contentLength));
    return HeadroomAudioResult::HttpFailed;
  }

  return playOwnedWav(wav, offset, true);
}

HeadroomAudioResult HeadroomAudio::playWavBytes(const uint8_t* wav, size_t length) {
  if (recording_) {
    return HeadroomAudioResult::Ignored;  // codec is in mic mode; never play
  }
  if (!wav || length == 0) {
    return HeadroomAudioResult::Ignored;
  }
  if (length > static_cast<size_t>(maxHttpBytes_)) {
    return HeadroomAudioResult::TooLarge;
  }

  uint8_t* owned = static_cast<uint8_t*>(ps_malloc(length));
  if (!owned) {
    owned = static_cast<uint8_t*>(malloc(length));
  }
  if (!owned) {
    return HeadroomAudioResult::DecodeFailed;
  }
  memcpy(owned, wav, length);

#ifdef HEADROOM_M12
  // The M12's Echo Base power amp (PI4IOE) is switched off by M5.Speaker's
  // idle auto-disable. A plain re-begin is a no-op when M5 still thinks the
  // speaker is started, so the atomic_echo enable callback never re-runs and the
  // amp stays off -> playback is barely audible. Force a full end->begin re-init
  // before each utterance so the PA is reliably powered back on. (Verified: an
  // explicit speaker re-begin restores full volume.) The lead-in silence in the
  // sender then absorbs the resulting ES8311 settle transient.
  resetSpeaker();
#endif

  return playOwnedWav(owned, length, true);
}

void HeadroomAudio::beginSpeaker() {
  M5.Speaker.setVolume(speakerVolume_);
  M5.Speaker.begin();
}

void HeadroomAudio::resetSpeaker() {
  M5.Speaker.stop();
  M5.Speaker.end();
  delay(20);
  beginSpeaker();
  // Let the ES8311 DAC fully re-stabilize after the ADC->DAC switch before the
  // caller drives it. resetSpeaker() runs in restoreAfterRecording(), i.e. on
  // the mic->speaker handoff right before the first TTS chunk plays. Without a
  // post-begin settle the leading tens of ms of that chunk can come out as
  // white noise / radio static when user speech and TTS collide (intermittent).
  // The other DAC paths already settle (resetSpeaker's end->begin gap above,
  // playCueTone's trailing delay); this closes the one that fed playback.
  delay(30);
}

void HeadroomAudio::releaseActive() {
  if (!activeWav_) {
    return;
  }
  if (!M5.Speaker.isPlaying()) {
    free(activeWav_);
    activeWav_ = nullptr;
    activeWavLength_ = 0;
    mouthPcm_ = nullptr;
    mouthSampleCount_ = 0;
  }
}

void HeadroomAudio::releaseQueued() {
  for (size_t i = 0; i < queuedWavCount_; ++i) {
    free(queuedWavs_[i].data);
    queuedWavs_[i].data = nullptr;
    queuedWavs_[i].length = 0;
  }
  queuedWavCount_ = 0;
}

bool HeadroomAudio::enqueueOwnedWav(uint8_t* wav, size_t length) {
  if (!wav || length == 0) {
    return false;
  }
  if (queuedWavCount_ >= kQueuedWavCapacity) {
    Serial.printf("wav fifo full count=%u capacity=%u\n", static_cast<unsigned>(queuedWavCount_), static_cast<unsigned>(kQueuedWavCapacity));
    return false;
  }
  queuedWavs_[queuedWavCount_].data = wav;
  queuedWavs_[queuedWavCount_].length = length;
  ++queuedWavCount_;
  return true;
}

bool HeadroomAudio::popQueuedWav(QueuedWav* out) {
  if (!out || queuedWavCount_ == 0) {
    return false;
  }
  *out = queuedWavs_[0];
  for (size_t i = 1; i < queuedWavCount_; ++i) {
    queuedWavs_[i - 1] = queuedWavs_[i];
  }
  --queuedWavCount_;
  queuedWavs_[queuedWavCount_].data = nullptr;
  queuedWavs_[queuedWavCount_].length = 0;
  return true;
}

HeadroomAudioResult HeadroomAudio::playOwnedWav(uint8_t* wav, size_t length, bool takeOwnership) {
  if (takeOwnership) {
    HeadroomAudioResult normalized = normalizeOwnedWav(&wav, &length);
    if (normalized != HeadroomAudioResult::Ok) {
      return normalized;
    }
  }
  releaseActive();
  if (M5.Speaker.isPlaying() || activeWav_) {
    if (!takeOwnership) {
      return HeadroomAudioResult::PlaybackFailed;
    }
    if (enqueueOwnedWav(wav, length)) {
      return HeadroomAudioResult::Ok;
    }
    free(wav);
    return HeadroomAudioResult::Ignored;
  }
  return startOwnedWavNow(wav, length, takeOwnership);
}

HeadroomAudioResult HeadroomAudio::startOwnedWavNow(uint8_t* wav, size_t length, bool takeOwnership) {
  releaseActive();
  M5.Speaker.stop();
  if (activeWav_) {
    free(activeWav_);
    activeWav_ = nullptr;
    activeWavLength_ = 0;
  }

  WavInfo info;
  if (!inspectWav(wav, length, &info) || info.audioFormat != 1 || info.bitsPerSample != 16 || info.channels != 1) {
    if (takeOwnership) {
      free(wav);
    }
    resetSpeaker();
    return HeadroomAudioResult::Unsupported;
  }

  int16_t* pcm = reinterpret_cast<int16_t*>(wav + info.dataOffset);
  size_t sampleCount = info.dataBytes / sizeof(int16_t);
  if (!pcmLooksSafe(pcm, sampleCount)) {
    Serial.println("wav pcm rejected by safety guard");
    if (takeOwnership) {
      free(wav);
    }
    resetSpeaker();
    return HeadroomAudioResult::Unsupported;
  }

  // Feed verified PCM directly. This avoids the M5Unified WAV parser path,
  // which is brittle around malformed or partially-delivered WAV headers.
  bool ok = M5.Speaker.playRaw(pcm, sampleCount, info.sampleRate, false, 1, -1, true);
  if (!ok) {
    if (takeOwnership) {
      free(wav);
    }
    resetSpeaker();
    return HeadroomAudioResult::PlaybackFailed;
  }

  if (takeOwnership) {
    activeWav_ = wav;
    activeWavLength_ = length;
  }

  // Anchor the mouth envelope to this chunk's real on-device playback. The
  // PCM stays valid for the duration of playback (owned buffer is kept in
  // activeWav_; the ingress buffer outlives the chunk it submitted).
  mouthPcm_ = pcm;
  mouthSampleCount_ = sampleCount;
  mouthSampleRate_ = static_cast<int>(info.sampleRate);
  mouthPlayStartMs_ = millis();
  return HeadroomAudioResult::Ok;
}

HeadroomAudioResult HeadroomAudio::normalizeOwnedWav(uint8_t** wav, size_t* length) {
  if (!wav || !*wav || !length || *length == 0) {
    return HeadroomAudioResult::Unsupported;
  }

  WavInfo info;
  if (!inspectWav(*wav, *length, &info)) {
    free(*wav);
    *wav = nullptr;
    *length = 0;
    return HeadroomAudioResult::Unsupported;
  }

  if (info.audioFormat == 1) {
    if (info.dataBytes > kMaxDecodedPcmBytes) {
      free(*wav);
      *wav = nullptr;
      *length = 0;
      return HeadroomAudioResult::TooLarge;
    }
    return HeadroomAudioResult::Ok;
  }

  if (info.audioFormat != 0x0011) {
    free(*wav);
    *wav = nullptr;
    *length = 0;
    return HeadroomAudioResult::Unsupported;
  }

  const size_t decodedBytes = static_cast<size_t>(info.factSampleCount) * sizeof(int16_t);
  if (decodedBytes == 0 || decodedBytes > kMaxDecodedPcmBytes) {
    free(*wav);
    *wav = nullptr;
    *length = 0;
    return HeadroomAudioResult::TooLarge;
  }

  const size_t pcmWavLength = 44 + decodedBytes;
  uint8_t* pcmWav = static_cast<uint8_t*>(ps_malloc(pcmWavLength));
  if (!pcmWav) {
    pcmWav = static_cast<uint8_t*>(malloc(pcmWavLength));
  }
  if (!pcmWav) {
    free(*wav);
    *wav = nullptr;
    *length = 0;
    return HeadroomAudioResult::DecodeFailed;
  }

  memcpy(pcmWav, "RIFF", 4);
  writeLe32(pcmWav + 4, static_cast<uint32_t>(pcmWavLength - 8));
  memcpy(pcmWav + 8, "WAVEfmt ", 8);
  writeLe32(pcmWav + 16, 16);
  writeLe16(pcmWav + 20, 1);
  writeLe16(pcmWav + 22, 1);
  writeLe32(pcmWav + 24, info.sampleRate);
  writeLe32(pcmWav + 28, info.sampleRate * 2);
  writeLe16(pcmWav + 32, 2);
  writeLe16(pcmWav + 34, 16);
  memcpy(pcmWav + 36, "data", 4);
  writeLe32(pcmWav + 40, static_cast<uint32_t>(decodedBytes));

  int16_t* output = reinterpret_cast<int16_t*>(pcmWav + 44);
  size_t outputSamples = 0;
  const size_t blockCount = info.dataBytes / info.blockAlign;
  for (size_t blockIndex = 0; blockIndex < blockCount; ++blockIndex) {
    const size_t remaining = static_cast<size_t>(info.factSampleCount) - outputSamples;
    const size_t wanted = min(static_cast<size_t>(info.samplesPerBlock), remaining);
    const uint8_t* block = *wav + info.dataOffset + (blockIndex * info.blockAlign);
    const size_t decoded = ima_adpcm_decode(block, info.blockAlign, output + outputSamples, wanted);
    if (decoded != wanted) {
      free(pcmWav);
      free(*wav);
      *wav = nullptr;
      *length = 0;
      return HeadroomAudioResult::DecodeFailed;
    }
    outputSamples += decoded;
  }

  if (outputSamples != info.factSampleCount) {
    free(pcmWav);
    free(*wav);
    *wav = nullptr;
    *length = 0;
    return HeadroomAudioResult::DecodeFailed;
  }

  Serial.printf("decoded IMA ADPCM wav compressed=%u pcm=%u rate=%u\n",
                static_cast<unsigned>(*length), static_cast<unsigned>(pcmWavLength),
                static_cast<unsigned>(info.sampleRate));
  free(*wav);
  *wav = pcmWav;
  *length = pcmWavLength;
  return HeadroomAudioResult::Ok;
}

bool HeadroomAudio::inspectWav(const uint8_t* wav, size_t length, WavInfo* info) {
  if (!wav || !info || length < 12 || memcmp(wav, "RIFF", 4) != 0 || memcmp(wav + 8, "WAVE", 4) != 0) {
    return false;
  }

  const size_t riffEnd = static_cast<size_t>(readLe32(wav + 4)) + 8;
  if (riffEnd < 12 || riffEnd > length) {
    return false;
  }

  WavInfo parsed;
  bool sawFmt = false;
  bool sawData = false;
  size_t offset = 12;
  while (offset + 8 <= riffEnd) {
    const uint8_t* chunk = wav + offset;
    const uint32_t chunkSize = readLe32(chunk + 4);
    const size_t chunkStart = offset + 8;
    if (chunkSize > riffEnd - chunkStart) {
      return false;
    }

    if (memcmp(chunk, "fmt ", 4) == 0) {
      if (sawFmt || chunkSize < 16) {
        return false;
      }
      parsed.audioFormat = readLe16(wav + chunkStart);
      parsed.channels = readLe16(wav + chunkStart + 2);
      parsed.sampleRate = readLe32(wav + chunkStart + 4);
      parsed.byteRate = readLe32(wav + chunkStart + 8);
      parsed.blockAlign = readLe16(wav + chunkStart + 12);
      parsed.bitsPerSample = readLe16(wav + chunkStart + 14);
      if (parsed.sampleRate < kMinPlaybackSampleRate || parsed.sampleRate > kMaxPlaybackSampleRate) {
        return false;
      }

      if (parsed.audioFormat == 1) {
        const uint16_t expectedBlockAlign =
            static_cast<uint16_t>((parsed.channels * parsed.bitsPerSample) / 8);
        const uint32_t expectedByteRate = parsed.sampleRate * expectedBlockAlign;
        if (parsed.channels != 1 || parsed.bitsPerSample != 16 || expectedBlockAlign != 2 ||
            parsed.blockAlign != expectedBlockAlign || parsed.byteRate != expectedByteRate) {
          return false;
        }
      } else if (parsed.audioFormat == 0x0011) {
        if (chunkSize < 20 || parsed.channels != 1 || parsed.bitsPerSample != 4 ||
            parsed.blockAlign < 5 || parsed.byteRate == 0) {
          return false;
        }
        const uint16_t extraSize = readLe16(wav + chunkStart + 16);
        parsed.samplesPerBlock = readLe16(wav + chunkStart + 18);
        const size_t expectedSamplesPerBlock =
            (static_cast<size_t>(parsed.blockAlign) - 4) * 2 + 1;
        if (extraSize < 2 || parsed.samplesPerBlock != expectedSamplesPerBlock) {
          return false;
        }
      } else {
        return false;
      }
      sawFmt = true;
    } else if (memcmp(chunk, "fact", 4) == 0 && chunkSize >= 4) {
      parsed.factSampleCount = readLe32(wav + chunkStart);
    } else if (memcmp(chunk, "data", 4) == 0) {
      if (!sawFmt || sawData || chunkSize == 0 || parsed.blockAlign == 0 ||
          chunkSize % parsed.blockAlign != 0) {
        return false;
      }
      parsed.dataOffset = chunkStart;
      parsed.dataBytes = chunkSize;
      sawData = true;
    }

    const size_t next = chunkStart + chunkSize + (chunkSize & 1);
    if (next <= offset || next > riffEnd) {
      return false;
    }
    offset = next;
  }

  if (!sawFmt || !sawData) {
    return false;
  }
  if (parsed.audioFormat == 0x0011) {
    const size_t blockCount = parsed.dataBytes / parsed.blockAlign;
    const size_t maximumSamples = blockCount * parsed.samplesPerBlock;
    const size_t minimumSamples = (blockCount - 1) * parsed.samplesPerBlock + 1;
    if (parsed.factSampleCount < minimumSamples || parsed.factSampleCount > maximumSamples) {
      return false;
    }
  }

  *info = parsed;
  return true;
}

bool HeadroomAudio::pcmLooksSafe(const int16_t* samples, size_t sampleCount) {
  if (!samples || sampleCount == 0) {
    return false;
  }

  uint64_t sumSquares = 0;
  size_t nearClip = 0;
  for (size_t i = 0; i < sampleCount; ++i) {
    int32_t sample = samples[i];
    int32_t magnitude = sample < 0 ? -sample : sample;
    sumSquares += static_cast<uint64_t>(magnitude) * static_cast<uint64_t>(magnitude);
    if (magnitude >= kNearClipSample) {
      ++nearClip;
    }
  }

  uint32_t rms = static_cast<uint32_t>(sqrt(static_cast<double>(sumSquares) / static_cast<double>(sampleCount)));
  uint8_t nearClipPercent = static_cast<uint8_t>((nearClip * 100) / sampleCount);
  if (rms > kMaxSafeRms || nearClipPercent > kNearClipPercentLimit) {
    Serial.printf("wav pcm unsafe rms=%u near_clip=%u%% samples=%u\n", static_cast<unsigned>(rms), static_cast<unsigned>(nearClipPercent),
                  static_cast<unsigned>(sampleCount));
    return false;
  }
  return true;
}

bool HeadroomAudio::isDuplicateAudio(const String& audioId, int generation) const {
  if (audioId.length() == 0) {
    return false;
  }
  for (size_t index = 0; index < kRecentAudioCapacity; ++index) {
    if (recentAudio_[index].id == audioId &&
        (generation < 0 || recentAudio_[index].generation < 0 ||
         recentAudio_[index].generation == generation)) {
      return true;
    }
  }
  return false;
}

void HeadroomAudio::rememberAudio(const String& audioId, int generation) {
  if (audioId.length() == 0) {
    return;
  }
  recentAudio_[nextRecentAudio_].id = audioId;
  recentAudio_[nextRecentAudio_].generation = generation;
  nextRecentAudio_ = (nextRecentAudio_ + 1) % kRecentAudioCapacity;
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
