# Separate Interpreter Stack Guide

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

The interpreter is a separate runtime stack, not a provider loaded inside the
operator process. It has its own mobile page, Node entry, provider presets,
session state, and setup commands. Starting the normal operator does not start
Gemma 4, Nemotron, Supertonic, or the interpreter's Qwen3-TTS process. The
two-pane launchers can nevertheless hand the shared right pane and port 8765
between Operator and Interpreter from one authenticated Mode dialog; the left
shell or coding agent stays running.

### Choose one preset

| Preset | Speech recognition and source-language detection | Translation | Speech output | End-to-end condition and picker ceiling |
|---|---|---|---|---|
| `gemma4-supertonic` | Gemma 4 12B audio through llama.cpp | Gemma 4 12B | Supertonic 3 on CPU | Gemma recognition ∩ Gemma translation ∩ Supertonic; 31 candidates |
| `gemma4-qwen3` | Gemma 4 12B audio through llama.cpp | Gemma 4 12B | Qwen3-TTS 0.6B on GPU | Gemma recognition ∩ Gemma translation ∩ Qwen3-TTS; 10 candidates |
| `nemotron-gemma4-supertonic` | NVIDIA Nemotron 3.5 ASR 0.6B on GPU | Gemma 4 12B | Supertonic 3 on CPU | Nemotron recognition ∩ Gemma translation ∩ Supertonic; 26 out-of-box candidates |
| `nemotron-gemma4-qwen3` | NVIDIA Nemotron 3.5 ASR 0.6B on GPU | Gemma 4 12B | Qwen3-TTS 0.6B on GPU | Nemotron recognition ∩ Gemma translation ∩ Qwen3-TTS; 10 out-of-box candidates |

Gemma performs intent analysis and translation in every preset; no active
interpreter preset requires `agy`, a cloud credential, or a translation
network round trip. `gemma4-supertonic` is the default and the lighter local
choice. The two ASRs have different recognition, language-coverage, latency,
and failure characteristics; neither is declared universally more accurate.
Choose a Nemotron preset when comparing an independent ASR is worth the extra
model and VRAM, and measure it with your speakers and noise conditions. Choose
Qwen3-TTS when its voice or Chinese output matters more than the extra GPU
memory and startup time. The old `light-cloud` name is accepted only as a
deprecated alias for `nemotron-gemma4-supertonic`. The web page displays the
active preset. In a supported two-pane tmux launch, its Mode dialog can
explicitly replace the right-pane backend with another installed allowlisted
preset.

The counts above are picker ceilings, not claims that every listed language has
equal recognition or translation quality. A spoken pair works end to end only
when the selected ASR recognizes both speakers, Gemma translates both
directions, and the selected TTS speaks both targets.

### Measured one-sentence comparison

The following medians are from one warm-up plus three measured passes on the
RTX PRO 4500 32 GB host. Every preset received the same 3.622-second synthetic
16 kHz WAV, “こんにちは。今日はいい天気ですね。雨は降るかな？”, used Gemma
MTP draft 8, and produced the same transcript and English translation. Browser
speech was encoded as MP3 at 128 kbit/s.

| Preset | Turn response: ASR + intent + translation | Translation to encoded audio ready | Request to encoded audio ready | Incremental loaded GPU memory | Practical characteristic |
|---|---:|---:|---:|---:|---|
| `gemma4-supertonic` | 1.124 s | 0.960 s | 2.082 s | 8,397 MiB | Fastest/lightest starting point; CPU TTS; 31 TTS languages, not Chinese |
| `nemotron-gemma4-supertonic` | 1.188 s | 0.957 s | 2.144 s | 11,176 MiB | Independent ASR and bounded Gemma fallback; about 2.8 GiB more GPU |
| `gemma4-qwen3` | 1.113 s | 3.234 s | 4.337 s | 10,894 MiB | Chinese-capable voice and ten-language TTS; slower/heavier speech synthesis |
| `nemotron-gemma4-qwen3` | 1.173 s | 3.279 s | 4.451 s | 13,677 MiB | Heaviest path; independent ASR plus Chinese-capable bidirectional speech |

“Audio ready” includes TTS synthesis and MP3 encoding, but not playback of the
generated 4.319-second Supertonic or 5.920-second Qwen audio. Loaded memory is
the whole-device difference while a stable live stack remained resident; it is
useful as an incremental preset measurement, not a universal minimum. This is
one clean synthetic voice—not a human/noisy-room, Atom microphone, Tailnet,
ADPCM-transfer, or statistical accuracy benchmark.

For one synthetic Mandarin input, “你好。今天天气很好。会下雨吗？”, Nemotron
returned the exact sentence and a correct English translation; Gemma-only ASR
detected Chinese but mis-transcribed the words. Median transcript events were
60 ms for Nemotron and 543 ms for Gemma, and complete turn responses were
0.649 s and 1.258 s respectively. This is useful evidence for trying
`nemotron-gemma4-qwen3` first for a bidirectional Mandarin pair, not proof that
Nemotron is always better. Qwen is an output requirement when the translated
speech itself must be Chinese; the ASR choice is a separate input-quality
decision and should still be checked with the actual speakers and room.

### Preview and install

Every normal launcher is offline-only. Model acquisition happens only in an
explicit setup command. Previewing is safe and does not create an environment,
contact a model repository, bind a port, or start a process:

    ./scripts/setup-interpreter-stack.sh --preset gemma4-supertonic --dry-run
    ./scripts/setup-interpreter-stack.sh --preset gemma4-qwen3 --dry-run
    ./scripts/setup-interpreter-stack.sh --preset nemotron-gemma4-supertonic --dry-run
    ./scripts/setup-interpreter-stack.sh --preset nemotron-gemma4-qwen3 --dry-run

Then install only the chosen preset:

    ./scripts/setup-interpreter-stack.sh --preset nemotron-gemma4-supertonic
    GEMMA4_MTP=on ./scripts/interpreter-doctor.sh --preset nemotron-gemma4-supertonic

Approximate model transfers are 4.9 GB for Nemotron, 400 MB for Supertonic,
2.4 GiB for Qwen3-TTS, and about 7.2 GB for Gemma main plus its matching audio
projector. Gemma 4 weights are Apache-2.0; Hugging Face may rate-limit
unauthenticated downloads. Setup records and verifies the pinned revision and
hashes of installed speech assets in Git-ignored runtime state.

All four presets require a compatible `llama.cpp` for Gemma audio and
translation. The default is a sibling checkout named `llama.cpp`; set
`LLAMA_CPP_DIR` or pass `--llama-dir` for another location. Check an existing
checkout without changing it:

    ./scripts/check-llama-gemma4.sh --mtp-mode on

If no compatible checkout exists, first preview the explicit clone/build into
a new path, then repeat without `--dry-run`:

    ./scripts/setup-llama-cpp-gemma4.sh --check-deps
    ./scripts/setup-llama-cpp-gemma4.sh \
      --prefix /path/to/new/llama.cpp-gemma4 --dry-run

The installer never pulls, resets, or rebuilds an existing checkout. An already
verified main GGUF and assistant GGUF are reused; daily startup needs only the
runtime binary and completed files. Source conversion tools are additionally
required only when rebuilding the MTP assistant.

Setup is resumable. If one provider's validation stops the aggregate command,
fix or update that provider environment and run the same preset command again.
Existing dedicated venvs and Hugging Face snapshots are reused; a completed
Nemotron snapshot is not downloaded as another 4.9 GB copy.

Phone playback uses the host `ffmpeg` command with its `libmp3lame` encoder to
produce the same 128-kbit/s MP3 format used by the working Arcade Music Player
mobile path. Setup does not install or upgrade this OS package implicitly.
`interpreter-doctor.sh` reports whether the encoder is available. If it is
missing or an individual conversion fails, that utterance still plays through
the larger PCM16 fallback. Set `MH_INTERPRETER_FFMPEG_COMMAND` only when the
compatible FFmpeg binary is not on `PATH`.

Supertonic is pinned to `supertonic==1.3.1` and the model revision selected by
that package (`724fb5abbf5502583fb520898d45929e62f02c0b`). This is deliberate:
the package-compatible revision is safer than silently following the model
repository head. The upstream project announced that its open-source repository
would be archived, so the local stack treats the pinned, already-published
runtime as a stable dependency instead of assuming future maintenance.

Use the read-only update checker to compare pins with current repository heads.
It reports differences and never upgrades anything:

    ./scripts/check-interpreter-model-updates.sh

### Start, open, restart, and stop

For loopback desktop testing:

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic

The launcher attaches to a dedicated two-pane tmux window. The left pane is a
normal Bash shell; the right pane shows the ASR/model, Silero VAD, TTS,
interpreter server, and Atom bridge logs. Run `codex resume --last` in the left
pane when you also want Codex there. Press `Ctrl-b d` to detach without stopping
the interpreter. `--no-attach` creates the same two panes in the background.

The launcher automatically reads persistent defaults from
`${MH_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/minimum-headroom.env}` when
that file exists. Explicit command options or environment values win. The file
accepts `KEY=VALUE` or `export KEY=VALUE`; it is parsed as data rather than
executed as a shell script. You do not need `set -a`. Keep authentication tokens
in this ignored per-user file, never in the public repository.

The operator and interpreter both default to port 8765 and never run there at
the same time. Use the Mode dialog for an in-place handoff when either
two-pane launcher created the window; for a manual cold start, stop the other
stack first. Sharing the default keeps the face Atom's saved endpoint and an
existing Tailnet rule unchanged. If an unrelated process owns 8765, the
interpreter refuses to start before loading a model; it never kills that
process automatically.

For phone or face Atom access, first put a strong
`MH_INTERPRETER_AUTH_TOKEN` in the persistent environment file, ensure the
intended network boundary serves or allows 8765, then start:

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic \
      --host 0.0.0.0 --no-attach

Bootstrap the phone once with `?auth_token=<token>`, using the host address and
port 8765. Keep firewall or Tailscale rules as the primary boundary. The face
Atom already configured for the operator's 8765 endpoint needs no port change.
A tested 32 GB Gemma/Supertonic configuration is:

    ./scripts/run-interpreter-once.sh \
      --preset gemma4-supertonic \
      --host 0.0.0.0 \
      --gemma-mtp on \
      --draft-tokens 8 \
      --supertonic-voice F2

If a machine normally uses that exclusive Atom configuration, the equivalent
non-secret values may be stored in `~/.config/minimum-headroom.env`:

    INTERPRETER_HOST=0.0.0.0
    INTERPRETER_PORT=8765
    GEMMA4_MTP=on
    GEMMA4_INTERPRETER_DRAFT_TOKENS=8
    MH_SUPERTONIC_VOICE=F2

Then the start command is only:

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic

When the interpreter tmux window already exists, restart only its right stack
pane. The left shell and attached client remain in place. Settings supplied to
the original start command are preserved; persistent config, environment
values, or the same `--host`/`--port`/`--gemma-mtp`/`--draft-tokens`/
`--supertonic-voice` options can replace them:

    ./scripts/restart-interpreter-stack-in-place.sh \
      --preset nemotron-gemma4-supertonic

Stop the dedicated interpreter window, including both of its panes:

    ./scripts/stop-interpreter-stack.sh

The scripts never kill a process merely because it owns a port. If a required
port is occupied, inspect it and choose a different port or stop the known
owner. Before persistent overrides, the ports are 8765 for the interpreter
page, 8095 for Nemotron, 8093 for Gemma, and 8094 for interpreter Silero VAD.
Operator Silero VAD stays on 8092.

<a id="runtime-mode-switch"></a>
### Switch mode or backend from the web page

The same compact dialog is present in both applications. Tap the `Operator`
title in the Operator panel, or tap the active provider name at the top of the
Interpreter page. Choose `Mode`, choose one `Backend preset`, then press
`Switch`. Merely opening the dialog or changing a select does not stop or load
anything.

The dialog can perform both kinds of change:

- Operator to Interpreter, or Interpreter to Operator.
- One Operator profile to another Operator profile.
- One Interpreter preset to another Interpreter preset.

The current right-pane stack stops before the selected stack starts, so two
large model sets are never resident by design. The page reconnects to the same
origin on port 8765 and reloads when the selected backend reports ready. The
left tmux pane, its working directory, and a running Codex or shell process are
not replaced. The persistent Operator Atom bridge is stopped before
Interpreter starts; switching back starts and verifies the Operator bridge
again. The Atom and the Tailnet rule therefore keep the same endpoint.

This exclusivity covers only processes owned by the shared right pane. A model
server started from the left pane, another tmux session, a system service, or
Docker remains the user's responsibility. In particular, the M12 may stay
connected, but its separately launched diffusiongemma/vLLM backend is not
stopped by this dialog. Check free VRAM or stop a known external GPU model
before selecting Interpreter. The rollback attempt does not terminate external
processes to reclaim memory.

This control is available only when `run-operator-once.sh` or
`run-interpreter-once.sh` created a marked two-pane window. A face-only launch,
a direct low-level stack command, or an old one-pane Interpreter session shows
the dialog as unavailable. Start once with a current two-pane launcher to
enable it. Manual restart scripts also refuse to overwrite the opposite active
mode; use the dialog for a cross-mode handoff.

Only the six documented Operator profiles and the four Interpreter presets are
accepted. The authenticated API accepts a mode plus one exact allowlisted
selection, never a shell command. Selecting a preset does not install it or
download a model. If the selected stack is missing, exits, or does not become
healthy, the controller makes one attempt to restore the exact previous
mode/preset and reports the result in the dialog. If restoration also fails,
the right backend pane contains the recovery logs.

The first two-pane launch records the non-secret recipe used by later switches.
Put stable choices in the normal per-user defaults file when Operator should
later start Interpreter without extra shell setup:

    MH_RUNTIME_INTERPRETER_PRESET=gemma4-supertonic
    GEMMA4_MTP=on
    GEMMA4_INTERPRETER_DRAFT_TOKENS=8
    MH_SUPERTONIC_VOICE=F2

Both one-shot launchers read this file automatically; `set -a` is not needed.
Authentication tokens and arbitrary agent launch commands are not copied into
tmux switch commands or returned by the runtime API. Use one shared
`MH_FACE_AUTH_TOKEN` when both modes must remain accessible from the same
already-authorized phone page; Interpreter accepts it as its authentication
fallback.

### Daily use and mobile controls

1. Start exactly one preset and open its dedicated page. Confirm the route strip
   says `Audio: Phone` or `Audio: Atom` and shows the intended preset.
2. With the face Atom connected, double-tap its screen to toggle continuous VAD
   on or off. In VAD mode, speak normally and pause to end the turn. The Atom
   microphone and speaker are half-duplex, so capture resumes only after real
   playback and the hardware cooldown.
3. In noise, long-press the Atom screen, wait for the cue, speak, and release
   for physical PTT. This does not permanently disable VAD.
4. Without Atom, hold the large phone `Hold to speak` control, speak, and
   release. iPhone/iPad may require the first user tap to unlock audio.
5. Stop the complete interpreter with `./scripts/stop-interpreter-stack.sh`, or
   use `Ctrl-b d` when only detaching from tmux.

The compact mobile page keeps the mode/backend control inside the active
provider label rather than adding a permanent row of buttons:

- `LANGUAGE PAIR` is both the current server-owned pair and the button that
  opens the English-name picker. `Apply pair` commits both sides once.
- `LATEST TURN` shows the last completed transcript and translation. It is
  restored after page sleep/reconnect, but it is not LLM conversation history.
- `Reset pair` clears the pair and cached completed turns for that session.
- `Listening on Atom` is a disabled status control, not a playback button. Atom
  owns both input and output while it is connected.
- `Play last translation` appears only when phone playback needs a user gesture.
  It stays hidden in Atom mode because replaying on the phone would violate the
  selected output route.
- The small speaker/value control appears only when connected Atom firmware
  advertises runtime volume control. Its sheet provides 0–200, ±8,
  `Mute`/`Indoor`/`Outdoor`; changes are temporary and reboot restores the
  provisioned baseline.

### Conversation rule

The server, not browser local storage or an LLM chat history, owns the language
pair. Browser storage contains only a reconnectable session ID.

1. The first translation target is always English. First Spanish speech becomes
   Spanish to English and fixes the pair as Spanish and English.
2. If the first speech is English, the server keeps `English ↔ unset` and
   displays the transcript. When Atom is the active audio endpoint, it asks
   “What language should I translate into?” in English once. A phone-only
   session asks on screen without playing an unsolicited prompt. It does not
   create an English-to-English translation or guess a target.
3. Once the pair exists, either language translates into the other.
4. A spoken instruction such as “translate to Japanese” updates the partner
   language. With Spanish already anchored, the pair becomes Spanish and
   Japanese. A command-only turn changes state without speaking empty text.
5. A confidently detected third language can replace the partner. Short or
   uncertain speech does not immediately rewrite the pair: it needs confidence
   at least 0.70, a detected tag with at least 700 ms of speech, a detected tag
   with at least four graphemes, or the same uncertain candidate twice within
   30 seconds.
6. `Reset pair` clears both languages and restores English as the first target.

Tap the `Language Pair` readout to choose both languages manually. The native
picker uses English language names in alphabetical order and commits only when
`Apply pair` is pressed, so changing both sides creates one revision rather than
two partial pair changes. Applying the current pair again is a no-op. The list
is the declared candidate range of the selected preset, not an end-to-end
quality guarantee: `gemma4-supertonic` exposes the 31-language Supertonic
ceiling, `gemma4-qwen3` exposes the 10-language Qwen3-TTS ceiling,
`nemotron-gemma4-supertonic` exposes the 26-language out-of-box
Nemotron/Supertonic intersection, and `nemotron-gemma4-qwen3` exposes all ten
Qwen3 languages, including Mandarin, because every one is in Nemotron's
transcription-ready or broad-coverage tiers. Actual spoken operation still
requires Gemma translation in every preset and Gemma audio recognition in the
two Gemma-ASR presets. Manual selection writes the same server session state as
a voice instruction; it does not call ASR, an LLM, or translation.

When a complete pair is committed by an explicit target instruction, an
accepted third language, or manual `Apply pair`, the server queues two short
notices before the translation: one with each language as the TTS language
hint. It does not announce the initial implicit source-to-English pair, an
ordinary direction reversal inside the same pair, an unresolved candidate, a
duplicate turn, a same-pair manual apply, or a reset. These notices are
deterministic local text, not another LLM request. Each notice is best effort:
one unsupported or failed language does not block the other notice or the text
translation.

The target is resolved before translation. A successful translation commits the
pair once; a later TTS failure does not erase it. Repeating the same turn ID
does not commit state or queue speech twice.

The server remains the source of truth when the phone page is opened after an
Atom-only conversation has already started. On initial load, and whenever the
active Atom endpoint changes, the WebSocket reconnects, or the phone page
returns from sleep/background, the page reads the current session snapshot and
hydrates both `Language Pair` and the latest completed speech turn. A manual
pair change does not replace that latest turn, and `Reset pair` clears it. This
bounded display snapshot is not conversation history and is never added to an
ASR, intent, or translation prompt. The page does not require another utterance
or rely on a previously observed WebSocket event.

### Data retention

Normal interpreter operation does not write microphone audio, transcripts, or
translations to files. Incoming audio exists only while a request is being
processed. Generated playback audio is a `no-store` binary reference held in
server memory for 60 seconds by default. The browser persists only a random
session ID; turn text stays in the page's memory and DOM.

The server session store is also memory-only. It keeps at most four completed
responses per session for immediate retry/idempotency and one of those as the
latest-turn UI snapshot. An inactive session expires after 30 minutes, process
restart drops every session, and `Reset pair` immediately clears the previous
turn responses for that session. The launcher does not pipe tmux panes to a log
file, and normal interpreter messages do not print transcript or translation
text.

Explicit diagnostics are different. Benchmark/smoke commands may write
Git-ignored test output. `MH_TTS_CAPTURE_ANOMALY=1` may write a
speech-containing WAV when investigating corrupt TTS and is off by default;
its JSON omits input text and request identifiers unless
`MH_TTS_CAPTURE_INCLUDE_TEXT=1` or
`MH_TTS_CAPTURE_INCLUDE_CONTEXT=1` is separately enabled. Treat any captured
WAV as sensitive and remove it after diagnosis.

### Phone and Atom audio

There is no route selector.

- With no Atom connected, the phone supplies the microphone and speaker. Hold
  the large button while speaking, then release to translate.
- While an authenticated Atom endpoint is healthy, the page changes to
  `Audio: Atom`, disables phone recording, and uses Atom mic plus Atom speaker.
  Speak naturally; Atom VAD ends a turn after the configured silence.
- In a noisy place, long-press the Atom screen button instead. Wait for the
  short cue, speak, and release. This physical PTT bypasses the VAD threshold,
  but then joins the same selected ASR, pair resolver, translation, and TTS
  pipeline. It does not change the saved VAD setting; hands-free capture
  resumes after the normal half-duplex cooldown.
- Endpoint choice is latched at the beginning of a turn. If Atom disconnects
  during that turn, text remains visible, but the same TTS is not replayed on
  the phone. The next turn uses the newly available route.

For firmware compatibility, physical PTT still calls the historical
`/api/operator/asr` and `/api/operator/response` endpoint names. The dedicated
interpreter server maps that two-stage exchange to the active Atom interpreter
session. It runs the ASR selected by the startup preset with automatic language
detection; the firmware's saved `asr_language` query hint does not restrict an
interpreter turn. This is a server-side adapter, so an Atom image that already
has working physical PTT does not need another flash for this route.

Atom's Echo Base uses one half-duplex codec for mic and speaker. Its existing
firmware suspends capture during real playback and resumes after the actual
playback completion plus the hardware cooldown. The server does not predict
phone playback duration or install a timer-based cross-device mute.

`MH_ATOM_TTS_CODEC=auto` is the default. New firmware advertises standard IMA
ADPCM WAV support, so Atom-only TTS is about one quarter of PCM size; old or
unknown firmware automatically receives PCM. `pcm16` and `ima_adpcm` are
startup-only troubleshooting overrides. The phone/iOS path uses one
same-origin binary reference per utterance: `audio/mpeg`, mono MP3 at a nominal
128 kbit/s. It uses the page's persistent unlocked HTML audio element and does
not use WebM/Opus. A normal ten-second phone utterance is about 160 kB as MP3,
compared with about 640 kB for 24-kHz PCM16 or 1.176 MB for 44.1-kHz PCM16
after Base64 WebSocket expansion. The base interpreter works with old Atom
firmware, but the new firmware must be flashed to enable compressed
PC-to-Atom playback.

Updated firmware also exposes the Atom's current `speaker_volume`. Keep the
faced Atom's saved indoor baseline at 112 and temporarily raise it outdoors
without restarting the interpreter:

    node scripts/atoms3r-volume.mjs --preset outdoor  # 160
    node scripts/atoms3r-volume.mjs --preset indoor   # 112

This runtime setting returns to the saved baseline at Atom reboot. Persist a
different baseline with `atoms3r-provision.mjs --speaker-volume <0..200>`.
When updated firmware reports volume capability, the mobile route strip shows
one compact speaker/value control. Tap it to open the 0–200 slider, ±8 controls,
and Mute/Indoor/Outdoor presets. Slider movement updates the number locally and
sends only the released value. The browser calls the authenticated same-origin
Interpreter API; the Atom URL and token never enter browser JavaScript. Values
above 200 are rejected throughout the stack because they produce strong
radio-like speaker noise on the tested hardware. This UI changes only the live
value; it never writes NVS.

### Speech-language coverage

Nemotron's current official model card lists 19 transcription-ready locales and
13 additional broad-coverage locales. Eight further locales are tokenizer/
adaptation-ready and should not be presented as out-of-box transcription
quality. Supertonic explicitly supports 31 languages; Qwen3-TTS in this stack
supports Chinese, English, Japanese, Korean, German, French, Russian,
Portuguese, Spanish, and Italian.

The implementation exposes the following four preset-specific candidate lists.
Names match the English language picker. These are the languages left after
the declared static ASR/TTS filters; Gemma recognition and/or translation
remains a runtime requirement in every row.

| Preset | Candidate languages shown by the picker |
|---|---|
| `gemma4-supertonic` (31) | Arabic, Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish, Ukrainian, Vietnamese |
| `gemma4-qwen3` (10) | Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish |
| `nemotron-gemma4-supertonic` (26) | Arabic, Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Hindi, Hungarian, Italian, Japanese, Korean, Polish, Portuguese, Romanian, Russian, Slovak, Spanish, Swedish, Turkish, Ukrainian, Vietnamese |
| `nemotron-gemma4-qwen3` (10) | Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish |

The actual conditions are, respectively: Gemma recognition ∩ Gemma translation
∩ Supertonic; Gemma recognition ∩ Gemma translation ∩ Qwen3-TTS; Nemotron
recognition ∩ Gemma translation ∩ Supertonic; and Nemotron recognition ∩ Gemma
translation ∩ Qwen3-TTS. Nemotron's bounded Gemma-ASR fallback may recover a
specific unusable transcript, but it does not turn the third and fourth rows
into Gemma-only presets.

Pair-change notices do not use a separate seven-language allowlist. The
selected TTS engine's complete list in
`config/models/interpreter-speech.json` is the pronunciation boundary, and
tests keep that manifest synchronized with the JavaScript gate and both Python
TTS engines. At runtime the ASR/TTS gate starts with the language actually
returned by the selected ASR intersected with that TTS list, and a completed
turn additionally requires Gemma translation. The manifest records the
declared out-of-box Nemotron intersections: 26 languages with Supertonic and
all ten Qwen3-TTS languages. Mandarin (`zh-CN`) belongs to Nemotron's
broad-coverage tier; adaptation-only locales are excluded. Gemma 4's official
material describes multilingual audio but does not publish an exact
authoritative audio language-code list, so this project does not invent a
narrower static Gemma list: it accepts an observed Gemma language only when
Gemma translation succeeds and the selected TTS can speak it. Thus the table
contains candidate ceilings rather than a claim of uniform support quality.

Translation text may succeed for a language that the chosen TTS does not
support. In that case the page shows the translation and a speech-unavailable
status. It never substitutes a nearby language or silently speaks with the
wrong profile.

With Gemma ASR, Gemma performs transcription first and then analyzes that
verified transcript for a spoken target-language instruction. With Nemotron
ASR, the same text provider accepts only the trusted normalized transcript
produced inside the server pipeline; browser text cannot bypass ASR. If
Nemotron returns one of its three unusable-result details
(`language_tag_missing`, `terminal_language_tag_missing`, or
`empty_transcript`), the hybrid preset sends the same WAV to its already
running Gemma audio provider exactly once. A successful Gemma transcription
continues through the normal state resolver and translation path. Timeouts,
connection failures, 5xx responses, and unknown 422 responses are not hidden
behind this fallback.

A normal turn uses one intent request, whose matching candidate translation is
reused. A content-bearing instruction that changes the language pair is the
exception: the server discards the advisory candidate and makes one text-only
translation request with the newly resolved target. Thus an utterance such as
“Good evening. Switch to Spanish” changes both the pair and that utterance's
translation to Spanish; it cannot replay an English candidate from the old
pair. This adds a call only to an explicit, content-bearing pair change.
If Gemma returns the internally inconsistent combination
`command_only=true` with no target language, the provider makes one bounded
corrective intent request using the original transcript. It never retries in a
loop, and it reports an error without changing the pair if the correction is
still inconsistent.

### Gemma 4 and MTP

All four presets use the same official main GGUF and matching `mmproj` for
intent analysis and translation. The two Gemma-ASR presets also send audio to
that server on every turn; the two Nemotron presets normally use it after
Nemotron ASR and additionally for the bounded one-shot audio fallback described
above.
`GEMMA4_MTP=off` is the default. `on` additionally loads the converted Google
assistant GGUF for llama.cpp `draft-mtp`; `auto` remains off unless a matching
local benchmark manifest explicitly recommends it:

    ./scripts/run-interpreter-once.sh \
      --preset gemma4-supertonic --gemma-mtp off
    ./scripts/run-interpreter-once.sh \
      --preset gemma4-supertonic --gemma-mtp on --draft-tokens 8

MTP can improve token generation but cannot accelerate ASR preprocessing, audio
upload, TTS, or network time. It also consumes memory, so it must be measured on
the actual hardware. Gemma requests use greedy decoding with `seed=0` and
`cache_prompt=false`; llama.cpp warns that prompt-cache batch differences can
otherwise make off/on output comparisons nondeterministic. MTP correctness is
graded against the same main model with MTP off, not against absolute ASR
perfection.

For the current RTX PRO 4500 split provider, draft 8 measured 875.70 ms median
for a complete turn versus 1,713.52 ms off; draft 16 was slower at 913.52 ms.
All 24 draft-8 turns were direction/schema valid and normalized-equivalent to
off. One German case chose equally valid comma/period punctuation. This can
happen because speculative verification batches target-model logits
differently from one-token decoding, even though the main model still verifies
every accepted token. It is not evidence that the assistant replaces or lowers
the target model's semantic quality.

`GEMMA4_MTP` remains off by default. When it is explicitly on, the measured
draft default is 8; set `GEMMA4_INTERPRETER_DRAFT_TOKENS` to override it.
See the [Gemma 4 and llama.cpp Guide](gemma4-llama-cpp.md#english)
for artifact hashes, MTP validation, and the reproducible assistant conversion.

### Third-party models and licenses

Minimum Headroom source code is [MIT licensed](../../LICENSE). The explicit
interpreter setup downloads or uses separate third-party components; their
licenses do not become the Minimum Headroom license:

| Component selected by setup/runtime | Upstream terms recorded for this stack | Important distinction |
|---|---|---|
| Google Gemma 4 main, projector, and assistant weights | [Apache-2.0](https://ai.google.dev/gemma/apache_2) | The converted/quantized GGUF remains derived from those weights; preserve required notices when redistributing it |
| NVIDIA Nemotron 3.5 ASR weights | [OpenMDW-1.1](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b#licenseterms-of-use) | Installed only by a Nemotron preset |
| Supertonic 3 model assets | [BigScience OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE) | The `supertonic` Python package/source is separately [MIT](https://github.com/supertone-inc/supertonic/blob/main/LICENSE) |
| Qwen3-TTS model and `qwen-tts` package | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice) | Installed only by a Qwen preset |
| llama.cpp | [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | External checkout/build; not bundled model weights |
| Silero VAD | [MIT](https://github.com/snakers4/silero-vad/blob/master/LICENSE) | Used for continuous speech segmentation |
| FFmpeg and libmp3lame | [FFmpeg licensing](https://ffmpeg.org/legal.html) and [LAME licensing](https://github.com/lameproject/lame/blob/master/COPYING) | FFmpeg is LGPL by default but a particular build may enable GPL components; inspect the installed binary/package |

The repository does not redistribute these model files. Setup downloads only
the chosen preset into local caches/directories and normal start is offline.
Anyone redistributing a cache, GGUF, container, appliance, or binary package
must review the exact upstream version, notices, use restrictions, and the
actual FFmpeg build configuration. Quantization and format conversion do not
erase upstream terms. This inventory is a provenance aid, not legal advice.
The machine-readable pins and URLs are in
`config/models/gemma4-interpreter.json` and
`config/models/interpreter-speech.json`.

### Troubleshooting

Run the doctor before starting a preset:

    GEMMA4_MTP=off ./scripts/interpreter-doctor.sh --preset gemma4-supertonic
    GEMMA4_MTP=off ./scripts/interpreter-doctor.sh --preset gemma4-qwen3
    GEMMA4_MTP=on ./scripts/interpreter-doctor.sh --preset nemotron-gemma4-supertonic
    GEMMA4_MTP=on ./scripts/interpreter-doctor.sh --preset nemotron-gemma4-qwen3

Useful symptoms:

- `missing environment`: run setup for exactly that preset; launchers never
  download at startup.
- `Gemma audio/text runtime ready` is missing on a Nemotron preset: the hybrid
  still needs Gemma main/mmproj (and the assistant GGUF when MTP is on) for
  intent and translation.
- `Translation is ready. Speech is unavailable`: text translation succeeded,
  but the selected TTS has no declared language support.
- `Speech was unclear. Please try again.` on a Nemotron preset: Nemotron did
  not produce a usable tagged transcript and the one-shot Gemma audio fallback
  also could not recover it. That automatic Atom VAD segment is ignored without
  changing the language pair or latest completed turn. Speak again; explicit
  PTT/upload errors and provider outages remain visible failures rather than
  being silently hidden.
- `Audio: Atom` but no phone PTT button: expected; Atom owns both mic and
  speaker while present. Use hands-free VAD or long-press the physical Atom
  button for PTT.
- `browser TTS MP3 encoder ... PCM16`: install an FFmpeg build containing
  `libmp3lame`, or set `MH_INTERPRETER_FFMPEG_COMMAND` to one. Translation and
  playback continue, but the fallback consumes more mobile data.
- wrong pair after a clear instruction: use `Reset pair`, retain the transcript
  and provider logs, and reproduce with the deterministic state tests.
- stale `Latest Turn` after the phone wakes: bring the interpreter page to the
  foreground. Visibility, page restore, focus, online, and WebSocket-open
  events all request the same bounded session snapshot; no manual reload should
  be necessary.
- iPhone plays no audio in phone mode until tapped: use
  `Play last translation`; the page keeps a dedicated unlock element and a
  persistent playback element. In Atom mode the replay button remains hidden
  because Atom, not the phone, owns translation playback.

<a id="japanese"></a>
## 日本語

通訳はoperator processへproviderを追加する仕組みではなく、独立したruntime stackです。
専用モバイル画面、Node entry、provider preset、言語状態、setup commandを持ちます。
通常のoperatorを起動しても、Gemma 4、Nemotron、Supertonic、通訳用Qwen3-TTSは起動
しません。ただし二ペインlauncherでは、認証済みの一つのMode dialogから、共通の右ペインと
port 8765をOperatorとInterpreterの間で引き渡せます。左のshellまたはcoding agentは
そのまま動き続けます。

### 四つのプリセット

| プリセット | 音声認識・言語判定 | 翻訳 | 音声出力 | end-to-end条件とpicker上限 |
|---|---|---|---|---|
| `gemma4-supertonic` | llama.cpp の Gemma 4 12B 音声入力 | Gemma 4 12B | Supertonic 3（CPU） | Gemma音声認識 ∩ Gemma翻訳 ∩ Supertonic、候補31言語 |
| `gemma4-qwen3` | llama.cpp の Gemma 4 12B 音声入力 | Gemma 4 12B | Qwen3-TTS 0.6B（GPU） | Gemma音声認識 ∩ Gemma翻訳 ∩ Qwen3-TTS、候補10言語 |
| `nemotron-gemma4-supertonic` | Nemotron 3.5 ASR 0.6B（GPU） | Gemma 4 12B | Supertonic 3（CPU） | Nemotron音声認識 ∩ Gemma翻訳 ∩ Supertonic、out-of-box候補26言語 |
| `nemotron-gemma4-qwen3` | Nemotron 3.5 ASR 0.6B（GPU） | Gemma 4 12B | Qwen3-TTS 0.6B（GPU） | Nemotron音声認識 ∩ Gemma翻訳 ∩ Qwen3-TTS、out-of-box候補10言語 |

全presetで意図解析と翻訳はローカルGemma 4が行い、`agy`、cloud credential、翻訳の
network往復を必要としません。既定かつ比較的軽いのは`gemma4-supertonic`です。
二つのASRは認識傾向、対応言語、速度、失敗特性が異なり、どちらが常に高精度とは
断定しません。独立ASRとの比較が追加modelとVRAMに見合う場合にNemotron構成を選び、
利用者の声と騒音条件で測定してください。Qwen3構成は音声品質または中国語出力を
重視する代わりにGPUメモリと起動時間が増えます。
旧`light-cloud`名は`nemotron-gemma4-supertonic`の非推奨aliasとしてだけ受理します。
対応する二ペインtmux起動では、Web画面のMode dialogから、導入済みallowlist内presetへ
右側backendを明示的に切り替えられます。

表の候補数はpicker上限であり、全言語が同じ認識・翻訳品質になるという保証ではありません。
双方向の音声通訳には、選択ASRが両話者を認識し、Gemmaが両方向を翻訳でき、選択TTSが
両方の翻訳先を発音できることが必要です。

### 一つの固定文での四構成実測

RTX PRO 4500 32 GBで、warm-up一回後に三回測った中央値です。四構成へ同じ3.622秒の
16 kHz合成音声「こんにちは。今日はいい天気ですね。雨は降るかな？」を渡し、Gemmaは
MTP draft 8、browser音声はMP3 128 kbit/sとしました。全構成が文字起こしを完全一致させ、
同じ英訳を返しました。

| プリセット | ASR＋意図解析＋翻訳response | 翻訳完了から音声encode完了 | requestから音声encode完了 | 追加loaded GPU memory | 特徴 |
|---|---:|---:|---:|---:|---|
| `gemma4-supertonic` | 1.124秒 | 0.960秒 | 2.082秒 | 8,397 MiB | 最も軽く速い出発点。CPU TTS、31言語だが中国語音声なし |
| `nemotron-gemma4-supertonic` | 1.188秒 | 0.957秒 | 2.144秒 | 11,176 MiB | 独立ASRと限定Gemma fallback。GPUを約2.8 GiB追加 |
| `gemma4-qwen3` | 1.113秒 | 3.234秒 | 4.337秒 | 10,894 MiB | 中国語を含む10言語の音声。音声合成は重く遅い |
| `nemotron-gemma4-qwen3` | 1.173秒 | 3.279秒 | 4.451秒 | 13,677 MiB | 最重量。独立ASRと中国語を含む双方向音声 |

音声encode完了にはTTS合成とMP3変換を含みますが、生成されたSupertonic 4.319秒／Qwen
5.920秒の再生時間は含みません。GPU値は安定したlive stackを残したまま測ったdevice全体の
差分で、普遍的な最低必要量ではありません。cleanな合成一話者だけの結果で、human speech、
屋外騒音、Atom mic、Tailnet、ADPCM転送、統計的精度の順位を表しません。

合成中国語「你好。今天天气很好。会下雨吗？」の一例では、Nemotronは全文を正しく
文字起こしして正しい英訳を返し、Gemma単独ASRは中国語判定には成功したものの単語を
取り違えました。文字起こしevent中央値はNemotron 60 ms、Gemma 543 ms、turn全体は
0.649秒と1.258秒でした。この結果から、双方向中国語では
`nemotron-gemma4-qwen3`を最初に試す根拠はありますが、Nemotronが常に高精度という証明では
ありません。翻訳音声そのものを中国語で出すにはQwenが必要であり、入力ASRの選択とは
別問題です。実際の話者と場所でも比較してください。

### 導入

通常の起動はすべてoffline-onlyです。model取得は明示的なsetupだけが行います。

    ./scripts/setup-interpreter-stack.sh --preset gemma4-supertonic --dry-run
    ./scripts/setup-interpreter-stack.sh --preset gemma4-supertonic
    ./scripts/interpreter-doctor.sh --preset gemma4-supertonic

Nemotronの聞き取りとQwen3音声を両方使う場合:

    ./scripts/setup-interpreter-stack.sh --preset nemotron-gemma4-qwen3 --dry-run
    ./scripts/setup-interpreter-stack.sh --preset nemotron-gemma4-qwen3
    GEMMA4_MTP=on ./scripts/interpreter-doctor.sh --preset nemotron-gemma4-qwen3

`--dry-run` は環境作成、download、port bind、process起動を行いません。概算downloadは
Nemotron 4.9 GB、Supertonic 400 MB、Qwen3-TTS 2.4 GiB、Gemma本体と対応projectorが
約7.2 GBです。Gemma 4 weightsはApache-2.0で、未認証のHugging Face downloadは
rate limitされる場合があります。選んでいないpresetのmodelは導入しません。

四構成ともGemma音声入力と翻訳のため互換`llama.cpp`が必要です。既定はこのrepositoryと
同じ親directoryにある`llama.cpp`で、別の場所は`LLAMA_CPP_DIR`または`--llama-dir`で
指定します。既存checkoutは変更せずread-onlyで確認できます。

    ./scripts/check-llama-gemma4.sh --mtp-mode on

互換checkoutがなければ、新しいpathへのclone/buildをまずpreviewし、確認後に
`--dry-run`だけを外します。

    ./scripts/setup-llama-cpp-gemma4.sh --check-deps
    ./scripts/setup-llama-cpp-gemma4.sh \
      --prefix /path/to/new/llama.cpp-gemma4 --dry-run

installerは既存checkoutをpull、reset、rebuildしません。検証済みmain/MTP GGUFは再利用し、
日常起動は完成binaryとGGUFだけで動きます。MTP assistantを再変換する場合だけsource
converterとそのdependencyも必要です。

setupは再実行できます。途中のprovider検証で一括commandが停止した場合は、環境を修正後
同じpreset commandを再実行してください。既存の専用venvとHugging Face snapshotを再利用
するため、取得済みNemotronを別の4.9 GB copyとして取り直しません。

スマホ再生は、Arcade Music Playerで正常動作しているものと同じMP3 128 kbit/s形式を
hostの`ffmpeg`と`libmp3lame`で生成します。setupはOS packageを暗黙に導入・更新しません。
doctorがencoderを検査し、見つからない場合や一発話の変換に失敗した場合だけ、容量の大きい
PCM16へfallbackします。互換FFmpegが`PATH`上にない場合だけ
`MH_INTERPRETER_FFMPEG_COMMAND`で指定します。

Supertonicは `supertonic==1.3.1` と、そのpackageが選ぶ互換revision
`724fb5abbf5502583fb520898d45929e62f02c0b` に固定しています。upstream headを無条件に
追わず、公開済みローカルruntimeを再現可能にするためです。更新確認はread-onlyです。

    ./scripts/check-interpreter-model-updates.sh

### 起動と停止

PC内だけで試す場合:

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic

専用tmux windowには左右二つのペインが表示されます。左は通常のBashで、必要なら
`codex resume --last`を実行できます。右にはASR/model、Silero VAD、TTS、
interpreter server、Atom bridgeのログが流れます。`Ctrl-b d`で通訳を停止せずdetach
でき、`--no-attach`なら同じ二ペインをbackgroundで作ります。

launcherは、存在する場合に
`${MH_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/minimum-headroom.env}`を
永続defaultとして自動的に読みます。command optionまたは呼出元の環境変数が優先です。
設定ファイルは`KEY=VALUE`または`export KEY=VALUE`をdataとしてparseするため、
`set -a`は不要です。認証tokenは公開repositoryではなく、このGit管理外の利用者別
設定ファイルに保存します。

operatorとinterpreterはどちらも既定で8765を使い、このportで同時には動きません。
どちらかの二ペインlauncherがwindowを作った場合は、Mode dialogでその場で引き渡します。
手動で新規起動する場合だけ、先にもう一方を停止してください。同じ既定portを使うため、
顔Atomに保存済みの接続先や既存Tailnet ruleを変更する必要はありません。無関係なprocessが
8765を所有中なら、interpreterはmodelをloadする前に失敗し、そのprocessを自動停止しません。

スマホまたは顔Atomから使う場合は、強い`MH_INTERPRETER_AUTH_TOKEN`を先に設定ファイルへ
置き、利用するnetwork境界で8765をserveまたは許可してから起動します。

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic \
      --host 0.0.0.0 --no-attach

スマホではhost addressのport 8765へ`?auth_token=<token>`を付けて最初の一回を開きます。
operatorの8765へ設定済みの顔Atomはport変更不要です。32 GB環境で確認済みの
Gemma/Supertonic起動例は次です。

    ./scripts/run-interpreter-once.sh \
      --preset gemma4-supertonic \
      --host 0.0.0.0 \
      --gemma-mtp on \
      --draft-tokens 8 \
      --supertonic-voice F2

普段からこの排他Atom構成を使うmachineなら、同じ非secret設定を
`~/.config/minimum-headroom.env`へ保存できます。

    INTERPRETER_HOST=0.0.0.0
    INTERPRETER_PORT=8765
    GEMMA4_MTP=on
    GEMMA4_INTERPRETER_DRAFT_TOKENS=8
    MH_SUPERTONIC_VOICE=F2

以後の起動commandは次だけです。

    ./scripts/run-interpreter-once.sh --preset gemma4-supertonic

既存の通訳windowを再起動すると、右側のstackペインだけが置き換わり、左のBashと
接続中のtmux clientは維持されます。最初の起動commandだけで指定した設定も保持し、
永続config、環境変数、同じ`--host`、`--port`、`--gemma-mtp`、`--draft-tokens`、
`--supertonic-voice` optionで置き換えられます。停止は専用windowの両ペインを閉じます。

    ./scripts/restart-interpreter-stack-in-place.sh \
      --preset nemotron-gemma4-supertonic
    ./scripts/stop-interpreter-stack.sh

port番号だけを根拠に未知processを終了しません。永続設定で上書きされる前のportは、
通訳画面8765、Nemotron 8095、Gemma 8093、通訳用Silero VAD 8094です。
operator用Sileroの8092とは分けています。

<a id="ja-runtime-mode-switch"></a>
### Web画面からモードまたはbackendを切り替える

両アプリに同じ小さなdialogがあります。Operator画面では`Operator`というtitleを、
Interpreter画面では上部の使用中provider名をtapします。`Mode`と`Backend preset`を
選び、最後に`Switch`を押します。dialogを開くことやselectを変更することだけでは、
processの停止やmodel loadは始まりません。

このdialogでは、次のどちらも行えます。

- OperatorとInterpreterの相互切替
- Operatorの六profile間、またはInterpreterの四preset間のbackend切替

選択したstackを開始する前に現在の右側stackを停止するため、大きなmodel群を意図せず
同時常駐させません。画面は同じoriginのport 8765へ再接続し、選択先のready確認後に
reloadします。左tmuxペイン、そのworking directory、実行中のCodexやshellは置き換えません。
Operatorの永続Atom bridgeはInterpreter開始前に停止し、Operatorへ戻る時に再起動と確認を
行います。このため顔AtomとTailnet ruleの接続先も変わりません。

この排他制御の対象は、共通の右ペインが所有するprocessだけです。左ペイン、別tmux session、
system service、Dockerから起動したmodel serverは利用者の管理対象として残ります。
特にM12自体は接続したままで構いませんが、別に起動したdiffusiongemma/vLLMはこのdialogでは
停止しません。Interpreter選択前に空きVRAMを確認するか、既知の外部GPU modelを停止して
ください。復元処理も、memory確保のため外部processを終了することはありません。

この機能は、`run-operator-once.sh`または`run-interpreter-once.sh`が作成した、印付きの
二ペインwindowだけで利用できます。face-only起動、低レベルstackの直接起動、旧一ペイン
Interpreter sessionでは、dialogに利用不可と表示します。現行の二ペインlauncherで一度
起動してください。手動restart scriptも、反対modeが動いている右ペインを上書きしないため、
modeをまたぐ時はdialogを使います。

受理するのは文書化したOperator六profileとInterpreter四presetだけです。認証済みAPIも
modeとallowlistに完全一致する一つの選択だけを受け、shell commandは受けません。
presetを選んでもinstallやdownloadは行いません。選択先が未導入、即終了、またはreadyに
ならない場合は、直前のmode/presetを一回だけ復元し、その結果をdialogへ表示します。
復元にも失敗した場合は、復旧に必要なログが右側のバックエンドペインに残ります。

最初の二ペイン起動時に、後の切替で使う非secret recipeを記録します。Operatorから追加の
shell設定なしでInterpreterを起動したい場合、安定した値は通常の利用者別設定へ置けます。

    MH_RUNTIME_INTERPRETER_PRESET=gemma4-supertonic
    GEMMA4_MTP=on
    GEMMA4_INTERPRETER_DRAFT_TOKENS=8
    MH_SUPERTONIC_VOICE=F2

両one-shot launcherがこのfileを自動的に読むため、`set -a`は不要です。認証tokenは
任意のagent起動commandとともにtmuxの切替commandへ複製せず、runtime APIからも返しません。
同じ認証済みスマホ画面から両modeを使う場合は、共通の`MH_FACE_AUTH_TOKEN`を使ってください。
Interpreterはこれを認証fallbackとして受理します。

### 日常操作とスマホUI

1. 一つのpresetだけを起動して専用画面を開き、上部が`Audio: Phone`または
   `Audio: Atom`と意図したpresetを示すことを確認します。
2. 顔Atom接続時は画面をダブルタップすると連続VADのon/offが切り替わります。VAD onでは
   普通に話して、発話終了時に少し黙ります。Atomのmicとspeakerはhalf-duplexなので、
   実再生完了とhardware cooldown後に録音を再開します。
3. 騒音下では顔Atom画面を長押しし、合図後に話して離すと物理PTTになります。保存済みVAD
   設定は変わりません。
4. Atom未接続時はスマホの大きな`Hold to speak`を押したまま話し、離します。
   iPhone/iPadは最初のuser tapで音声unlockが必要な場合があります。
5. tmux表示だけを閉じるなら`Ctrl-b d`、通訳全体を終了するなら
   `./scripts/stop-interpreter-stack.sh`を使います。

スマホ画面では、常設button列を増やさず、使用中provider名の中にmode/backend切替を
収めています。その他の表示の意味は次のとおりです。

- `LANGUAGE PAIR`全体が現在のserver管理pair表示とpickerを開くbuttonを兼ねます。言語名は
  英語表記で、`Apply pair`一回で両側をcommitします。
- `LATEST TURN`は最後に完了した文字起こしと翻訳です。sleep/reconnect後に復元しますが、
  LLMへ渡す会話履歴ではありません。
- `Reset pair`はそのsessionのpairと保持済み完了turnを消去します。
- `Listening on Atom`は再生buttonではなく無効化された状態表示です。Atom接続中はmicも
  speakerもAtomが所有します。
- `Play last translation`はスマホ再生にuser gestureが必要な時だけ現れます。Atom modeでは
  出力先を破らないよう表示しません。
- 小さなspeaker iconと数値は、接続中firmwareがvolume controlを通知した場合だけ現れます。
  開くと0〜200 slider、±8、`Mute`/`Indoor`/`Outdoor`があり、変更は一時的でreboot後は
  provision済みbaselineへ戻ります。

### 言語ペアの規則

1. 最初の翻訳先は必ず英語です。最初がスペイン語なら `Spanish → English` となり、
   ペアをSpanishとEnglishにします。
2. 最初が英語なら `English ↔ unset` のまま文字起こしを表示します。Atomが音声endpoint
   の場合は初回だけ “What language should I translate into?” と英語音声で尋ねます。
   スマホだけのsessionでは勝手に音声を出さず、画面で翻訳先を求めます。英語を英語へ
   訳したり、翻訳先を推測したりしません。
3. ペア確定後は、話された側からもう一方へ訳します。
4. 「日本語に訳して」のような音声指示があればpartnerを更新します。Spanishがanchor
   なら以後はSpanishとJapaneseを往復します。指示だけのturnでは空の翻訳を読みません。
5. 第三言語は、confidence 0.70以上、language tag付きで700 ms以上、tag付きで4文字
   以上、または30秒以内に同じ不確かな候補を2回検出した場合にだけペアを更新します。
6. `Reset pair` で両言語を消し、最初の翻訳先を英語へ戻します。

`Language Pair`の表示全体をtapすると、anchorとpartnerを手動選択できます。言語名は
英語表記のalphabetical順です。二つを選んで`Apply pair`を一回押した時だけ完全pairを
commitするため、片側ずつ二回revisionを増やしません。同じpairの再適用はno-opです。
表示範囲は選択presetの宣言済み候補で、end-to-end品質の保証listではありません。
`gemma4-supertonic`はSupertonicの31言語上限、`gemma4-qwen3`はQwen3-TTSの10言語上限、
`nemotron-gemma4-supertonic`はNemotron/Supertonicのout-of-box交差26言語です。
`nemotron-gemma4-qwen3`は、Qwen3の10言語すべて（中国語を含む）がNemotronの
transcription-readyまたはbroad-coverageに入るため、同じ10言語を表示します。
実際の音声通訳には全presetでGemma翻訳、Gemma ASR二構成ではGemma音声認識も必要です。
手動選択は音声指示と同じserver session stateを直接更新し、ASR、LLM、翻訳を追加で
呼びません。

明示した翻訳先、採用された第三言語、または手動の`Apply pair`によって完全なpairが
確定・変更された時は、翻訳本文より先に短い案内を二つqueueします。一つはanchor、もう
一つはpartnerを明示的なTTS language hintとして読み上げます。最初の暗黙な
source→English pair、同じpair内の通常の方向反転、未確定候補、duplicate turn、同じpair
の再適用、resetでは案内しません。この文面はLLMを追加で呼ばずローカルで決定します。
一方の言語がTTS非対応または失敗でも、もう一方の案内と翻訳本文は止めません。

状態の正本はserverです。翻訳成功後にTTSだけが失敗してもペアを巻き戻しません。同じ
turn IDを再送してもstate更新や読み上げを重複させません。

Atomだけで会話を始めた後にスマホ画面を開いた場合も、serverが言語pairの正本です。
画面は初期表示時、接続中Atomの切替時、WebSocket再接続時、スマホの
sleep/backgroundからの復帰時に現在のsession snapshotを読み、`Language Pair`と完了済み
最新発話一件を復元します。手動pair変更はその最新発話を置き換えず、`Reset pair`は
消去します。この表示用snapshotは会話履歴ではなく、ASR、intent、翻訳promptへ混ぜません。
次の発話を待ったり、休止中のWebSocket eventを受け取っていたことを前提にしません。

### データ保持

通常の通訳動作は、mic音声、文字起こし、翻訳文をfileへ書きません。入力音声は一回の
request処理中だけ存在します。生成した再生音声は`no-store`のbinary referenceとして
server memoryに置き、既定60秒で失効します。browserが永続化するのはrandomなsession ID
だけで、発話本文はpageのmemory/DOMだけにあります。

server session storeもmemory-onlyです。即時再送の重複処理を防ぐため、一sessionにつき
完了responseを最大4件だけ保持し、そのうち最新一件をUI復帰用snapshotにします。操作のない
sessionは30分で失効し、process再起動ですべて消え、`Reset pair`はそのsessionの過去responseを
直ちに消去します。launcherはtmux paneをlog fileへpipeせず、通常のinterpreter logへ
transcriptやtranslation本文を出しません。

明示的な診断だけは別です。benchmark/smoke commandはGit管理外のtest結果を保存する場合が
あります。破損TTSを調べる
`MH_TTS_CAPTURE_ANOMALY=1`は既定offですが、有効時は発話内容を含むWAVを書き得ます。
JSON側の入力本文とrequest識別子は、さらに`MH_TTS_CAPTURE_INCLUDE_TEXT=1`または
`MH_TTS_CAPTURE_INCLUDE_CONTEXT=1`を指定しない限り保存しません。capture WAVは機密情報
として扱い、診断後に削除してください。

### スマホとAtom

音声経路の手動切替はありません。Atom未接続ならスマホのmicとspeakerを使います。
認証済みAtomが接続中なら画面は `Audio: Atom` となり、スマホ録音を無効にしてAtomの
micとspeakerを使います。経路はturn開始時に固定され、途中でAtomが切断しても同じ音声を
スマホへ再送しません。

騒音下では顔Atomの画面ボタンを長押しし、短い合図音の後に話してから離します。この物理
PTTはVAD閾値を使いませんが、その後は起動presetで選択中のASR、言語pair判定、翻訳、TTS
という通常経路へ合流します。保存済みVAD設定は変えず、half-duplex cooldown後に
ハンズフリー録音を再開します。

firmware互換性のため、物理PTTは従来名の`/api/operator/asr`と
`/api/operator/response`を引き続き呼びます。専用通訳serverがこの二段階通信を接続中Atomの
通訳sessionへ対応付けます。ASRは起動presetで選んだものを自動言語判定で一度だけ実行し、
firmwareに保存された`asr_language` query hintは通訳言語を制限しません。この経路は
server側adapterなので、物理PTTがすでに動くfirmwareを再度書き込む必要はありません。

AtomのEcho Baseはmicとspeakerが同じhalf-duplex codecを使います。既存firmwareは実際の
再生中に録音を止め、実際の再生完了とhardware cooldown後に再開します。server側で
スマホの発話時間を予測するmute timerは追加していません。

`MH_ATOM_TTS_CODEC=auto`が既定です。新firmwareは標準IMA ADPCM WAV対応を通知するため、
Atom専用TTSはPCMの約4分の1になり、旧firmwareや能力不明時は自動でPCMへ戻ります。
`pcm16` / `ima_adpcm`の指定は起動時の切り分け用です。スマホ/iOS経路は一発話につき
同一originのbinary referenceを一つ送り、`audio/mpeg`のmono MP3 128 kbit/sを永続的な
unlock済みHTML audio elementで再生します。WebM/Opusは使いません。10秒発話はMP3なら
約160 kBで、Base64 WebSocketへ入れた24 kHz PCM16の約640 kB、44.1 kHz PCM16の
約1.176 MBより小さくなります。通訳本体は旧firmwareでも動きますが、PC→Atom圧縮再生を
有効にするには新firmwareの書き込みが必要です。

更新済みfirmwareは現在の`speaker_volume`も公開します。顔Atomの保存屋内baselineは112の
まま、通訳を再起動せず屋外だけ一時的に上げられます。

    node scripts/atoms3r-volume.mjs --preset outdoor  # 160
    node scripts/atoms3r-volume.mjs --preset indoor   # 112

このruntime値はAtom rebootで保存baselineへ戻ります。baseline自体は
`atoms3r-provision.mjs --speaker-volume <0..200>`で保存します。更新済みfirmwareが音量
capabilityを通知すると、スマホのroute stripにspeaker iconと現在値だけの小さなcontrolが
現れます。tapすると0〜200 slider、±8、Mute/Indoor/Outdoor presetが開き、sliderはdrag中の
値を画面に表示してrelease時だけ送信します。browserは認証済みのsame-origin Interpreter
APIだけを呼ぶため、AtomのURLとtokenをJavaScriptへ渡しません。実機で強い
トランシーバー状ノイズが出る200超はstack全体で拒否します。このUIは現在値だけを変え、
NVSへは書き込みません。

### 対応言語と制限

Nemotronは公式model card上、19のtranscription-ready localeと13のbroad-coverage
localeがout-of-box対象です。さらに8 localeはadaptation-readyで、fine-tuneなしの通常
認識対象とは区別します。Supertonicは31言語、ここでのQwen3-TTSは中国語、英語、日本語、
韓国語、ドイツ語、フランス語、ロシア語、ポルトガル語、スペイン語、イタリア語を明示対応
とします。

実装がpickerへ表示する四構成別の候補listは次です。言語名はUIの英語表記に合わせています。
宣言済みASR/TTSの静的filter後に残る言語であり、各行ともGemma音声認識またはGemma翻訳が
実行時条件として残ります。

| プリセット | pickerへ表示する候補言語 |
|---|---|
| `gemma4-supertonic`（31） | Arabic, Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Greek, Hindi, Hungarian, Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish, Ukrainian, Vietnamese |
| `gemma4-qwen3`（10） | Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish |
| `nemotron-gemma4-supertonic`（26） | Arabic, Bulgarian, Croatian, Czech, Danish, Dutch, English, Estonian, Finnish, French, German, Hindi, Hungarian, Italian, Japanese, Korean, Polish, Portuguese, Romanian, Russian, Slovak, Spanish, Swedish, Turkish, Ukrainian, Vietnamese |
| `nemotron-gemma4-qwen3`（10） | Chinese, English, French, German, Italian, Japanese, Korean, Portuguese, Russian, Spanish |

四構成の実条件は順に、Gemma音声認識 ∩ Gemma翻訳 ∩ Supertonic、Gemma音声認識 ∩
Gemma翻訳 ∩ Qwen3-TTS、Nemotron音声認識 ∩ Gemma翻訳 ∩ Supertonic、Nemotron音声認識 ∩
Gemma翻訳 ∩ Qwen3-TTSです。Nemotronの限定Gemma-ASR fallbackは特定の文字起こし不能を
回復するためのもので、後二構成をGemma単独ASR構成へ変えるものではありません。

言語pair案内に別の7言語allowlistは置きません。
`config/models/interpreter-speech.json`にある選択中TTSの全対応言語を発音可能範囲とし、
manifest、JavaScriptの実行時gate、Pythonの両TTS実装が一致することをtestで固定します。
実行時のASR/TTS gateは「選択中ASRがその発話で返した言語」と「選択中TTSの全対応言語」の
動的な交差から始まり、turn完了にはさらにGemma翻訳が必要です。Nemotronのout-of-box範囲
との静的交差は、Supertonicで26言語、Qwen3-TTSで10言語です。中国語`zh-CN`はNemotronの
broad-coverageに含まれ、adaptation-only localeは除外します。Gemma 4の公式資料は
多言語音声対応を示しますが、厳密な音声language code一覧は公開していないため、この
projectでは推測した狭い固定listを作りません。Gemmaが実際に返した言語をGemmaが翻訳でき、
TTS側でも発音できる場合だけ採用します。したがって上の表は候補上限であり、全言語で
一様な品質を保証するものではありません。

翻訳本文が成功してもTTS非対応言語の場合があります。その場合は翻訳を表示して音声非対応
を示し、近い別言語へ黙ってfallbackしません。

Gemma ASR構成では、Gemmaが最初に文字起こしし、その検証済みの文字起こし結果から発話内の
翻訳先指示を解析します。Nemotron ASR構成では、server内部でNemotronが生成・正規化した
transcriptだけをGemma text providerへ渡し、browser textからASRを迂回させません。
Nemotronが`language_tag_missing`、`terminal_language_tag_missing`、`empty_transcript`の
いずれかを返した場合だけ、同じWAVを既に常駐しているGemma audio ASRへ一回渡します。
Gemmaで文字起こしできれば通常の状態解決と翻訳を続行します。timeout、接続失敗、5xx、
未知の422にはfallbackせず、provider停止を隠しません。Gemmaも回復できなかった連続Atom
VAD区間だけを非致命的に破棄し、言語pairと最新の完了turnを変更しません。明示PTT／upload
では両方失敗したことをerrorとして返します。

通常turnの意図解析は一回で、方向が一致するcandidate translationも再利用します。ただし
本文を含む明示的なpair変更turnではcandidateを再利用せず、状態機械が決めた新しい翻訳先を
指定してtext-only翻訳を一回行います。例えば`ja↔en`で「こんばんは。スペイン語に切り替えて
ください」と言った場合、案内だけでなく同じturnの「こんばんは」もSpanishになります。
追加callはこの明示pair変更turnだけで、通常の往復速度は変わりません。
Gemmaが`command_only=true`なのに翻訳先言語を空で返す内部矛盾が起きた時だけ、同じ原文を
使って意図解析を一回だけ補正します。繰り返し再試行はせず、補正後も矛盾する場合は言語pairを
変更せずerrorとして報告します。

### Gemma 4とMTP

GemmaのMTPは既定でoffです。`on` は変換済みassistant GGUFも読み、`auto` は同一構成の
合格benchmark manifestがある場合だけ有効になります。MTPは音声前処理、upload、TTSを
速くせず、memoryも使うため、実機測定前に自動有効化しません。Gemma requestはgreedy、
`seed=0`、`cache_prompt=false`に固定します。llama.cppのprompt cacheはbatch差による
非決定性を持ち得るため、MTP correctnessは絶対ASR一致ではなく同じmainのoff出力との
同等性で判定します。

現在のRTX PRO 4500と分離providerでは、draft 8のturn全体中央値は875.70 ms、offは
1,713.52 msで、draft 16は913.52 msへ遅くなりました。draft 8は24/24 turnで方向とschemaが
妥当、正規化後はoffと24/24一致しました。一件のドイツ語だけcomma/periodが分岐しました。
speculative時は主modelが各tokenを検証していても、複数tokenのbatchと一tokenずつの計算で
量子化logitがbit一致しない場合があるためです。assistantが主modelを置き換えたり意味品質を
意図的に下げたりした結果ではありません。

`GEMMA4_MTP`はoffが既定です。明示的にonにした場合の実測draft既定値は8で、
`GEMMA4_INTERPRETER_DRAFT_TOKENS`により上書きできます。詳細は
[Gemma 4 and llama.cpp Guide](gemma4-llama-cpp.md#japanese)を参照してください。

### 第三者modelとライセンス

Minimum Headroom本体のsource codeは[MIT license](../../LICENSE)です。通訳の明示setupが
取得または利用する次のcomponentはそれぞれ別のupstream条件を持ち、Minimum Headroomの
licenseへ吸収されるものではありません。

| component | このstackで記録するupstream条件 | 注意点 |
|---|---|---|
| Google Gemma 4 main、projector、assistant weights | [Apache-2.0](https://ai.google.dev/gemma/apache_2) | 変換・量子化したGGUFも元weightsの派生物なので、再配布時は必要noticeを維持 |
| NVIDIA Nemotron 3.5 ASR weights | [OpenMDW-1.1](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b#licenseterms-of-use) | Nemotron presetを選んだ時だけ導入 |
| Supertonic 3 model assets | [BigScience OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE) | `supertonic` Python package/sourceは別に[MIT](https://github.com/supertone-inc/supertonic/blob/main/LICENSE) |
| Qwen3-TTS modelと`qwen-tts` package | [Apache-2.0](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice) | Qwen presetを選んだ時だけ導入 |
| llama.cpp | [MIT](https://github.com/ggml-org/llama.cpp/blob/master/LICENSE) | 外部checkout/buildで、model weightsではない |
| Silero VAD | [MIT](https://github.com/snakers4/silero-vad/blob/master/LICENSE) | 連続発話の区間判定に使用 |
| FFmpegとlibmp3lame | [FFmpeg license案内](https://ffmpeg.org/legal.html)と[LAME license](https://github.com/lameproject/lame/blob/master/COPYING) | FFmpegは既定LGPLですが、実際のbuildがGPL componentを有効にする場合があるため導入binary/packageを確認 |

このrepositoryはmodel fileを再配布しません。setupは選択presetだけをlocal cache/directoryへ
取得し、通常startはofflineです。cache、GGUF、container、appliance、binary packageを
再配布する場合は、利用者が正確なupstream version、notice、用途制限、実FFmpeg buildを
確認してください。量子化やformat変換で元の条件は消えません。この表は来歴確認用で、
法的助言ではありません。machine-readableなpinとURLは
`config/models/gemma4-interpreter.json`と`config/models/interpreter-speech.json`にあります。
