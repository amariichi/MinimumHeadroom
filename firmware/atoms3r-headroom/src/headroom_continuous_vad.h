#pragma once

#include <Arduino.h>

#include "face_renderer.h"
#include "headroom_audio.h"
#include "headroom_settings.h"
#include "headroom_transport.h"

// Continuous VAD state. Persistent enablement, transient suspension for
// playback or PTT, and a post-suspend cooldown are explicit states so the
// dispatcher in update() never starts the mic in a window where the shared
// ES8311 codec is about to be reconfigured for playback. Generation_ is
// bumped on every transition that invalidates buffered audio so the PC-side
// bridge can drop stale frames after suspension.
enum class HeadroomContinuousVadState {
  Disabled,
  Idle,
  Capturing,
  SuspendedForPlayback,
  SuspendedForPtt,
  Cooldown,
};

class HeadroomContinuousVad {
public:
  // Default cooldown after TTS playback ends before VAD may re-open the mic.
  // Important: this is measured from the moment audio_->busy() transitions
  // from true to false (i.e., from the actual end of playback), NOT from
  // when suspendForPlayback() was originally called. Otherwise a long TTS
  // utterance would consume the entire cooldown during playback, and VAD
  // would call startMic() — and therefore audio_->stopForRecording() with
  // M5.Speaker.end() — while the speaker amp tail was still settling,
  // producing an audible "ザザッ" at every TTS tail. The constant must be
  // long enough to cover the M5.Speaker end-to-restart transition AND the
  // speaker amplifier decay tail on ES8311 + Atomic Echo Base.
  static constexpr uint32_t kVadPlaybackCooldownMs = 1200;
  // Default cooldown after PTT releases.
  static constexpr uint32_t kVadPttCooldownMs = 700;
  // Anti-thrash hysteresis: minimum dwell in Cooldown regardless of the
  // requested cooldownMs. Prevents update() from re-opening M5.Mic on the
  // very next tick after a suspend, which is the regime that historically
  // produced rapid codec begin/end cycling.
  static constexpr uint32_t kCooldownMinDwellMs = 200;

  // Firmware-side speech gating. captureAndSend() drops frames whose RMS
  // amplitude (normalized to 0..1) is below the runtime-configurable
  // speech threshold AND the post-speech tail counter has expired,
  // before base64-encoding and the WebSocket send. This is the primary
  // bandwidth reduction for mobile-tethered operation. Speech onset is
  // preserved by sending the first frame above threshold (no pre-roll
  // buffer yet); tail context is preserved by sending speechTailFrames_
  // silent frames after the last speech frame so the PC-side bridge gets
  // enough trailing silence to finalize the utterance.
  //
  // INVARIANT: the tail duration (speechTailFrames_ * 64 ms) must exceed the
  // PC bridge's endSilenceMs, or the device stops sending before the bridge
  // has accumulated enough silence to finalize — the utterance then hangs
  // until the next speech. The default 16 frames (~1.0 s) clears the 900 ms
  // MH_ATOM_VAD_END_SILENCE_MS default with margin. A non-zero tail is what
  // lets vadFirmwareRms stay > 0 (idle silence skipped, ~zero bandwidth when
  // no one speaks) without chopping an utterance at every natural pause.
  //
  // The runtime threshold comes from HeadroomSettingsData::vadFirmwareRms and
  // the tail count from HeadroomSettingsData::vadSpeechTailFrames (both
  // NVS-persisted). For PC-side RMS backend the default 0.025 works in a quiet
  // room; for the Silero backend, set it to ~0.005 via the provisioning script
  // so Silero can see marginal-energy frames.
  static constexpr uint32_t kDefaultSpeechTailFrames = 16;  // ~1.0 s at 1024 samples / 16 kHz

  void begin(const HeadroomSettingsData& settings, HeadroomAudio& audio, HeadroomTransport& transport, HeadroomFaceState& faceState);
  void update();

  // Persistent enablement. Setting false moves the state machine to Disabled
  // and stops the mic; setting true moves it from Disabled to Idle so
  // update() can begin capturing on the next tick (subject to cooldown).
  void setEnabled(bool enabled);

  // Transient suspensions. Both stop the mic if capturing, transition to the
  // matching Suspended state, bump generation_, and arm cooldown.
  void suspendForPlayback(uint32_t cooldownMs = kVadPlaybackCooldownMs);
  void suspendForPtt(uint32_t cooldownMs = kVadPttCooldownMs);

  // Teardown-only alias for explicit stop (transport disconnect,
  // setEnabled(false)). Production playback/PTT paths must use
  // suspendForPlayback / suspendForPtt so cooldown is enforced.
  void stop();

  // True whenever the persisted/runtime intent is on, including Cooldown.
  // False when state_ == Disabled.
  bool enabled() const;

  // True only when state_ == Capturing (M5.Mic is open right now).
  bool active() const;

  // Monotonically increasing counter bumped on every transition that
  // invalidates buffered audio (suspend, disable, mic-stop).
  uint32_t generation() const;

  const char* stateName() const;

private:
  static constexpr uint32_t kSampleRate = 16000;
  static constexpr size_t kChunkSamples = 1024;

  HeadroomAudio* audio_ = nullptr;
  HeadroomTransport* transport_ = nullptr;
  HeadroomFaceState* faceState_ = nullptr;
  String asrLanguage_ = "ja";
  String encoding_ = "pcm16";
  float speechRms_ = 0.025f;
  uint32_t speechTailFrames_ = kDefaultSpeechTailFrames;
  HeadroomContinuousVadState state_ = HeadroomContinuousVadState::Disabled;
  uint32_t generation_ = 0;
  uint32_t suspendUntilMs_ = 0;
  uint32_t cooldownEnteredMs_ = 0;
  uint32_t seq_ = 0;
  uint32_t tailFramesRemaining_ = 0;
  int16_t frame_[kChunkSamples] = {};

  bool startMic();
  void stopMic();
  void captureAndSend();
  float frameRmsAmplitude() const;
  void enterCooldownIfCapturing(uint32_t cooldownMs, HeadroomContinuousVadState via, uint32_t nowMs);
  static void playbackCallback(void* context);
};
