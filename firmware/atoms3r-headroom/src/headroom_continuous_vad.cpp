#include "headroom_continuous_vad.h"

#include <M5Unified.h>

namespace {

uint32_t nowMillis() {
  return millis();
}

}  // namespace

void HeadroomContinuousVad::begin(const HeadroomSettingsData& settings, HeadroomAudio& audio, HeadroomTransport& transport,
                                  HeadroomFaceState& faceState) {
  audio_ = &audio;
  transport_ = &transport;
  faceState_ = &faceState;
  asrLanguage_ = HeadroomSettings::normalizeAsrLanguage(settings.asrLanguage);
  state_ = settings.continuousVadEnabled ? HeadroomContinuousVadState::Idle : HeadroomContinuousVadState::Disabled;
  // Transport's before-playback callback feeds the state machine, not stop()
  // directly. This keeps the cooldown hysteresis honest across both the WS
  // and HTTP playback paths.
  transport_->setBeforeAudioPlaybackCallback(&HeadroomContinuousVad::playbackCallback, this);
  Serial.printf("continuous VAD ready enabled=%s state=%s asr_lang=%s gen=%u\n",
                enabled() ? "yes" : "no", stateName(), asrLanguage_.c_str(),
                static_cast<unsigned>(generation_));
}

void HeadroomContinuousVad::update() {
  uint32_t now = nowMillis();

  // Unsafe-to-capture conditions short-circuit the dispatcher. audio_->busy()
  // covers the actual-playback window; audio_->recording() with mic not owned
  // by this VAD instance covers PTT. Either case forces capture to stop.
  if (!transport_ || !transport_->connected() || !audio_) {
    if (state_ == HeadroomContinuousVadState::Capturing) {
      stopMic();
    }
    return;
  }
  if (audio_->busy()) {
    // Treat ongoing playback as an in-flight suspension regardless of who
    // started it. Use the default playback cooldown so the post-playback
    // tail still gets the cooldown gate.
    if (state_ == HeadroomContinuousVadState::Capturing ||
        state_ == HeadroomContinuousVadState::Idle) {
      enterCooldownIfCapturing(kVadPlaybackCooldownMs, HeadroomContinuousVadState::SuspendedForPlayback, now);
    }
    return;
  }
  if (audio_->recording() && state_ != HeadroomContinuousVadState::Capturing) {
    // Mic is owned by something else (PTT). Make sure we are suspended.
    if (state_ == HeadroomContinuousVadState::Idle) {
      enterCooldownIfCapturing(kVadPttCooldownMs, HeadroomContinuousVadState::SuspendedForPtt, now);
    }
    return;
  }

  switch (state_) {
    case HeadroomContinuousVadState::Disabled:
      return;
    case HeadroomContinuousVadState::SuspendedForPlayback:
    case HeadroomContinuousVadState::SuspendedForPtt: {
      // audio_->busy() / audio_->recording() returned false above, so the
      // playback (or PTT recording) actually ended on this tick. Re-arm
      // suspendUntilMs_ from NOW + the appropriate cooldown, not from when
      // suspendForPlayback was originally called. Without this re-arm a
      // long TTS would consume the cooldown during playback and VAD would
      // immediately startMic() at TTS end, where audio_->stopForRecording()
      // calls M5.Speaker.end() into a still-settling amp -> audible click.
      uint32_t cooldownMs = (state_ == HeadroomContinuousVadState::SuspendedForPlayback)
                              ? kVadPlaybackCooldownMs
                              : kVadPttCooldownMs;
      suspendUntilMs_ = now + cooldownMs;
      cooldownEnteredMs_ = now;
      state_ = HeadroomContinuousVadState::Cooldown;
      Serial.printf("continuous VAD -> cooldown (post-event) gen=%u cooldown_ms=%u\n",
                    static_cast<unsigned>(generation_), static_cast<unsigned>(cooldownMs));
      return;
    }
    case HeadroomContinuousVadState::Cooldown: {
      uint32_t readyAt = suspendUntilMs_;
      uint32_t hysteresisReadyAt = cooldownEnteredMs_ + kCooldownMinDwellMs;
      if (readyAt < hysteresisReadyAt) {
        readyAt = hysteresisReadyAt;
      }
      if (now < readyAt) {
        return;
      }
      state_ = HeadroomContinuousVadState::Idle;
      // fall through to Idle handling below
      [[fallthrough]];
    }
    case HeadroomContinuousVadState::Idle: {
      if (!startMic()) {
        return;
      }
      // startMic() transitioned to Capturing
      [[fallthrough]];
    }
    case HeadroomContinuousVadState::Capturing: {
      captureAndSend();
      return;
    }
  }
}

void HeadroomContinuousVad::setEnabled(bool enabled) {
  if (enabled) {
    if (state_ == HeadroomContinuousVadState::Disabled) {
      state_ = HeadroomContinuousVadState::Idle;
      ++generation_;
      Serial.printf("continuous VAD enabled gen=%u\n", static_cast<unsigned>(generation_));
    }
  } else {
    if (state_ == HeadroomContinuousVadState::Capturing) {
      stopMic();
    }
    state_ = HeadroomContinuousVadState::Disabled;
    ++generation_;
    Serial.printf("continuous VAD disabled gen=%u\n", static_cast<unsigned>(generation_));
  }
}

void HeadroomContinuousVad::suspendForPlayback(uint32_t cooldownMs) {
  if (state_ == HeadroomContinuousVadState::Disabled) {
    return;
  }
  enterCooldownIfCapturing(cooldownMs, HeadroomContinuousVadState::SuspendedForPlayback, nowMillis());
}

void HeadroomContinuousVad::suspendForPtt(uint32_t cooldownMs) {
  if (state_ == HeadroomContinuousVadState::Disabled) {
    return;
  }
  enterCooldownIfCapturing(cooldownMs, HeadroomContinuousVadState::SuspendedForPtt, nowMillis());
}

void HeadroomContinuousVad::stop() {
  if (state_ == HeadroomContinuousVadState::Capturing) {
    stopMic();
  }
  if (state_ != HeadroomContinuousVadState::Disabled) {
    state_ = HeadroomContinuousVadState::Idle;
    ++generation_;
  }
}

bool HeadroomContinuousVad::enabled() const {
  return state_ != HeadroomContinuousVadState::Disabled;
}

bool HeadroomContinuousVad::active() const {
  return state_ == HeadroomContinuousVadState::Capturing;
}

uint32_t HeadroomContinuousVad::generation() const {
  return generation_;
}

const char* HeadroomContinuousVad::stateName() const {
  switch (state_) {
    case HeadroomContinuousVadState::Disabled: return "disabled";
    case HeadroomContinuousVadState::Idle: return "idle";
    case HeadroomContinuousVadState::Capturing: return "capturing";
    case HeadroomContinuousVadState::SuspendedForPlayback: return "suspended_for_playback";
    case HeadroomContinuousVadState::SuspendedForPtt: return "suspended_for_ptt";
    case HeadroomContinuousVadState::Cooldown: return "cooldown";
  }
  return "unknown";
}

// VAD shares the ES8311 codec lifecycle with PTT. The audio owner must be
// driven through stopForRecording() before M5.Mic.begin() (and through
// restoreAfterRecording() after M5.Mic.end()) so playback is properly
// inhibited and the I2S/codec is in a consistent state for ADC capture.
bool HeadroomContinuousVad::startMic() {
  if (state_ == HeadroomContinuousVadState::Capturing) {
    return true;
  }
  if (audio_->recording()) {
    return false;
  }
  audio_->stopForRecording();
  if (!M5.Mic.begin()) {
    Serial.println("continuous VAD M5.Mic.begin failed");
    audio_->restoreAfterRecording();
    return false;
  }
  state_ = HeadroomContinuousVadState::Capturing;
  ++generation_;
  if (faceState_) {
    faceState_->expression = HeadroomExpression::Listening;
    faceState_->mouthOpen = 0.0f;
  }
  Serial.printf("continuous VAD mic started gen=%u\n", static_cast<unsigned>(generation_));
  return true;
}

// Mirror of startMic(): always restore speaker mode through the audio owner
// so playback can resume. Pairs with stopForRecording() above.
void HeadroomContinuousVad::stopMic() {
  if (state_ != HeadroomContinuousVadState::Capturing) {
    return;
  }
  M5.Mic.end();
  if (audio_) {
    audio_->restoreAfterRecording();
  }
  if (faceState_) {
    faceState_->mouthOpen = 0.0f;
  }
  Serial.println("continuous VAD mic stopped");
  // Caller is responsible for the next state_; default to Idle so a plain
  // stopMic() does not lose the persisted enablement.
  state_ = HeadroomContinuousVadState::Idle;
}

void HeadroomContinuousVad::captureAndSend() {
  if (state_ != HeadroomContinuousVadState::Capturing || !transport_) {
    return;
  }
  if (!M5.Mic.record(frame_, kChunkSamples, kSampleRate, false)) {
    Serial.println("continuous VAD M5.Mic.record failed");
    return;
  }
  uint32_t waitStarted = millis();
  while (!M5.Mic.isRecording() && millis() - waitStarted < 20) {
    delay(1);
    M5.update();
  }
  while (M5.Mic.isRecording()) {
    delay(1);
    M5.update();
  }
  ++seq_;
  bool ok = transport_->sendAtomAudioFrame(frame_, kChunkSamples, kSampleRate, asrLanguage_, seq_, generation_);
  if (!ok) {
    Serial.println("continuous VAD audio frame send failed");
  }
}

void HeadroomContinuousVad::enterCooldownIfCapturing(uint32_t cooldownMs, HeadroomContinuousVadState via, uint32_t now) {
  if (state_ == HeadroomContinuousVadState::Capturing) {
    stopMic();
  }
  state_ = via;
  ++generation_;
  suspendUntilMs_ = now + cooldownMs;
  cooldownEnteredMs_ = now;
  Serial.printf("continuous VAD -> %s gen=%u cooldown_ms=%u\n", stateName(), static_cast<unsigned>(generation_),
                static_cast<unsigned>(cooldownMs));
}

void HeadroomContinuousVad::playbackCallback(void* context) {
  auto* self = static_cast<HeadroomContinuousVad*>(context);
  if (self) {
    self->suspendForPlayback();
  }
}
