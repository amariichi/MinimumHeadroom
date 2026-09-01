# AtomS3R Voice Guide (hands-free VAD, ADPCM, Silero)

End-to-end notes for the AtomS3R hands-free voice path: flashing, USB
provisioning, how the VAD pipeline segments turns, the RMS vs Silero backends,
every tuning knob, and troubleshooting. The top-level [README](../../README.md)
and the [Operator Stack Guide](operator-stack.md#english) stay shorter on
purpose; use this file when setting up or tuning an AtomS3R.

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Hardware

- **AtomS3R** (ESP32-S3) + **Atomic Echo Base** (ES8311 codec). The Echo Base is
  required — the AtomS3R has no built-in speaker, and the ES8311 is **half
  duplex**: it is either in mic (ADC) mode or speaker (DAC) mode, never both.
- USB-C to the PC for flashing and serial provisioning (`/dev/ttyACM0`).

### Flashing the firmware

> See the [firmware README](../../firmware/atoms3r-headroom/README.md#english) for
> firmware-project specifics — notably the **WebServer library patch** (auto-applied
> at build; required so chunked TTS doesn't stall ~5 s per chunk).

```bash
# build
.venv-platformio/bin/pio run -d firmware/atoms3r-headroom

# flash — the --no-stub upload flag is REQUIRED on this board
PLATFORMIO_UPLOAD_FLAGS=--no-stub \
  .venv-platformio/bin/pio run -d firmware/atoms3r-headroom -t upload \
  --upload-port /dev/ttyACM0
```

NVS settings (Wi-Fi, URLs, VAD config, and saved speaker volume) survive a reflash. The fresh-device
default is now `vad_encoding=ima_adpcm`, but an existing NVS value such as
`pcm16` is intentionally not migrated. After any flash or reboot, inspect
`RMHCFG?` and re-confirm both `vad_on` and `vad_encoding` (see troubleshooting).

### Building a release image (maintainers)

The normal build bakes `headroom_config.local.h` (your Wi-Fi / auth token / PC
URLs) into the binary as string literals — fine for your own device, but
**don't commit or share that binary**. To get a secret-free bundle for the
browser installer, build with the placeholder example config instead:

```bash
scripts/build-release-firmware.sh        # -> dist/atoms3r-firmware/
```

It forces the example config, **fails the build if any real value from your
`local.h` leaked** into the binary, and stages esp-web-tools artifacts
(`bootloader.bin` / `partitions.bin` / `boot_app0.bin` / `firmware.bin`),
`manifest.json`, and an `index.html` install page. Your real Wi-Fi/token live in
the device's NVS, not in these app artifacts, so the bundle carries no secrets;
you provision them on the device after flashing (see the setup portal below).

### Browser install (no toolchain)

Serve the `dist/atoms3r-firmware/` folder on localhost and open it in a Chromium
browser. esp-web-tools `fetch()`es the `manifest.json` and `.bin` files, so a
double-clicked `file://` page does **not** work — it needs `http://localhost`
(or HTTPS):

```bash
cd dist/atoms3r-firmware
python3 -m http.server 8099        # any free port
```

Then:

1. open `http://localhost:8099/` in **Chrome or Edge** (desktop — Web Serial is Chromium-only),
2. connect the AtomS3R over USB-C,
3. click **Install** and pick the device's serial port from the browser dialog
   (the port is chosen manually; the chip type is auto-detected).

> **Verified on AtomS3R:** esp-web-tools flashes this board from Chrome even
> though CLI flashing needs `--no-stub`. If a particular board/port misbehaves,
> the PlatformIO flow above is the fallback.

### Wi-Fi setup portal (no CLI)

After flashing, configure Wi-Fi and server URLs without any tools:

1. Enter the portal — **hold the screen button while powering on** (~2 s), or it
   starts automatically when no Wi-Fi is saved.
2. From a phone/PC, join the device's Wi-Fi access point **`RMH-SETUP-XXXX`**.
3. A captive page opens (or browse to the AP IP, usually `http://192.168.4.1`).
4. Fill in Wi-Fi SSID/password and the Face HTTP base / WebSocket URL (and optional
   mDNS host, auth token, VAD settings), **Save**, and restart.

**Field reference** — only three fields are mandatory; everything else has a
working default:

| Field | What to enter | |
|---|---|---|
| Wi-Fi SSID / password (#1–#3) | Networks tried in order (#1 first) | **required** |
| Face HTTP base & WebSocket URL | The PC on port 8765 — `http://<pc>:8765` and `ws://<pc>:8765/ws`. For off-LAN use, point them at a stable address (e.g. a Tailscale IP) | **required** |
| Auth token | The value of `MH_FACE_AUTH_TOKEN` (blank → the PC returns 401) | **required** |
| PC mDNS host | e.g. `my-pc.local` — auto-tracks the PC's IP on the home LAN; blank disables it | optional |
| **Continuous hands-free VAD** (checkbox) | **Check it for hands-free** (the device streams when it hears speech); unchecked = PTT only (long-press to talk). Easy to miss. | optional |
| Firmware VAD RMS threshold | On-device energy gate, matched to the backend: **RMS (default) → ~0.025**; **Silero → ~0.005** (kept low so the PC's Silero worker still sees marginal frames) | default |
| VAD audio encoding | `ima_adpcm` (fresh-device default, about 4:1) or `pcm16` (compatibility) | default |
| Post-playback VAD cooldown | Delay after physical playback ends before the shared codec returns to the mic; 1200 ms is conservative, 200 ms is the supported minimum | 1200 ms |
| Speaker volume | Safe range 0–200. Faced Atom: 112 indoor default; 160 is an outdoor starting point. M12 default: 200 | default |
| Device ID / agent IDs / ASR / TTS / rotation / pose | Sensible defaults — leave as-is unless you need to change them | default |

The VAD **backend** (RMS vs Silero) is a PC-side choice: **RMS is the default**;
Silero is opt-in (install `silero-vad-worker`, set `MH_ATOM_VAD_BACKEND=silero` —
see *Backends: RMS vs Silero* below). Set the device-side *Firmware VAD RMS
threshold* to match (≈0.025 for RMS, ≈0.005 for Silero).

### Provisioning over USB (RMHCFG)

`scripts/atoms3r-provision.mjs` pushes Wi-Fi / URLs / VAD config into NVS over
the serial line so you never type them into the Wi-Fi portal by hand:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --wifi "HomeSSID:pass" --wifi "CafeSSID:pass" \
  --http-base http://<pc-ip>:8765 --ws-url ws://<pc-ip>:8765/ws \
  --mdns-host <pc-hostname>.local \
  --device-id atom-headroom-1 --asr-lang ja \
  --vad-on --vad-rms 0.005 --vad-tail 8 --vad-encoding ima_adpcm \
  --speaker-volume 112 \
  --reboot
```

VAD-related flags: `--vad-on` / `--vad-off`, `--vad-rms <0..1>`,
`--vad-tail <0..240>`, `--vad-encoding pcm16|ima_adpcm`,
`--vad-playback-cooldown-ms <200..5000>`, `--speaker-volume <0..200>`,
`--asr-lang ja|en`.
For a known half-duplex Atom that settles cleanly, shorten only that device:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --vad-playback-cooldown-ms 200 --reboot
```

`--mdns-host <pc-hostname>.local` makes the device resolve the PC's current IP at
boot and rewrite the host in `--ws-url`/`--http-base`, so a DHCP change needs no
re-provisioning; it falls back to the static URLs when mDNS can't resolve (e.g.
off-LAN — keep those pointed at a stable address such as a Tailscale IP).
`--mdns-host ""` disables it. The PC needs an mDNS responder for this (on Ubuntu,
`avahi-daemon`); without one the device stays on the static URLs.

One PC usually publishes several addresses under one `.local` name — the LAN
address plus VPN (Tailscale) and container-bridge addresses — so the device asks
for every answer, prefers one on its own subnet, and opens a throwaway TCP
connection to the port before adopting it. An address that cannot be reached is
skipped instead of silently wedging the device. If the WebSocket then stays down
for a minute, the device re-resolves, and restarts only when a *different*
address passes the probe, so a PC that is merely switched off never causes a
restart loop. Read current state by sending `RMHCFG?` over the
serial port (115200, raw).

The host opens the USB CDC device once and sends harmless `RMHCFG?` probes until
the Atom returns `RMHCFG STATE`. Only then does it send the NVS-changing
`RMHCFG <json>` line, exactly once. This avoids the startup race seen when the
port exists before the firmware serial loop is ready, without risking repeated
NVS writes or reboots. On some hosts a firmware reboot removes `/dev/ttyACM0`
until the cable is reconnected; Wi-Fi operation can already have recovered
while the USB node is absent.

### Speaker output volume

Volume is the Atom's M5Unified hardware master level, not a gain applied to the
TTS waveform. It therefore behaves consistently across Kokoro, Supertonic, and
other TTS providers and does not add digital clipping. The supported safe range
is 0–200.

- Faced Atom saved default: **112** (the current indoor level).
- `outdoor`: **160**, a starting point rather than a guarantee. M5Unified's
  mixing curve is non-linear; 160 is about +6.2 dB relative to 112 in that
  curve.
- M12 saved default: **200**.
- Values above 200 are rejected by the UI, API, CLI, and firmware because the
  tested Atom/Echo Base produces strong radio-like noise in that range.

Change only the live level, without rebooting or changing NVS:

```bash
node scripts/atoms3r-volume.mjs --preset outdoor
node scripts/atoms3r-volume.mjs --preset indoor
node scripts/atoms3r-volume.mjs --volume 145
node scripts/atoms3r-volume.mjs --preset mute
```

The command uses `ATOM_HEADROOM_URL` or automatic `/health` discovery and the
same Atom/face auth-token environment used by the bridge. The live value appears
as `speaker_volume` in `/health`; reboot restores the saved baseline. To change
that baseline instead:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --speaker-volume 112 --reboot
```

The runtime endpoint and `speaker_volume` health field require the updated
firmware. The CLI detects older firmware and stops with an explicit flash-first
message. When compatible firmware is connected, the Interpreter phone UI shows
one compact speaker/value control in the route strip. Tap it to open the 0–200
slider, ±8 controls, and Mute/Indoor/Outdoor presets. Changes travel through the
authenticated same-origin Interpreter API and remain temporary until reboot.

The common Face App exposes the authenticated `GET/POST /api/atom/volume`
control path in both operator and Interpreter modes. The coding-agent MCP
server wraps it as three target-safe tools. `atom.volume.get` reads the live value, `atom.volume.set`
sets an exact `volume_percent` from 0–100, and `atom.volume.adjust` applies `up`
or `down` with optional `percentage_points` (default 5, clamped at 0% and 100%).
The MCP result reports both the model-facing percentage and the diagnostic raw
0–200 value; the MCP converts percentages to raw firmware units by multiplying
by two before calling the Face App. Every call requires
`target: "face"` or `target: "m12"`; the server maps that semantic target to
`ATOM_HEADROOM_DEVICE_ID` or `MH_M12_DEVICE_ID`, so a model cannot choose an
arbitrary connected device or URL. With `MCP_TOOL_NAME_STYLE=underscore`, the
published names are `atom_volume_get`, `atom_volume_set`, and
`atom_volume_adjust`. All three report `persistent: false`; use USB
provisioning when the saved reboot baseline must change.

There is deliberately no broad voice intent, so translated speech about
“volume” cannot be mistaken for a device command. A conversational coding agent
must deliberately select one of the target-safe MCP tools.

### How the VAD pipeline works

1. **Firmware** captures 1024-sample (64 ms) frames. An RMS energy gate
   (`vad_rms`) skips true idle silence to save bandwidth; after the last
   above-threshold frame it keeps sending `vad_tail` trailing frames so the
   word's decay is carried. Frames are optionally IMA-ADPCM compressed
   (`vad_encoding`) and streamed as `atom_audio_frame` over WebSocket.
2. **PC bridge** (`face-app`) decodes (ADPCM→PCM16), classifies each frame with
   a VAD backend, accumulates the turn, and **finalizes** it when
   `received_silence + (now − last_frame) ≥ endSilenceMs` **and**
   `speech ≥ minSpeechMs` (or `utterance ≥ maxUtteranceMs`). The wall-clock
   receive-gap term is what lets the firmware tail stay short — see below.
3. The finalized PCM16 goes to the **ASR worker** (parakeet) and the transcript
   is dispatched as an `operator_response`, exactly like the browser-mic path.

### Using Atom with the separate interpreter

The interpreter reuses the same frame decoder and VAD segmenter, but gives the
final WAV to the provider-neutral interpreter pipeline instead of Parakeet's
operator-response path. The provider then detects the source language
automatically. The firmware's saved `ja`/`en` ASR hint is not used to decide the
interpreter language. An older firmware can still run the interpreter through
the PCM compatibility path; the new firmware is required only for compressed
PC-to-Atom playback and capability advertising.

Physical PTT works in this mode too. The firmware deliberately keeps its
historical two-stage `/api/operator/asr` plus `operator_response` protocol; the
interpreter server recognizes that exchange, runs the preset's selected ASR
once with automatic language detection, and feeds the prepared result into the
normal interpreter turn. The saved firmware ASR hint is ignored for inference.
No firmware reflash is needed when physical PTT already works against the
operator service.

Atom can maintain one Face WebSocket destination at a time. The operator and
interpreter both default to the same exclusive port 8765, so an Atom already
configured for the operator needs no endpoint rewrite when the interpreter
takes over. Stop the active stack before starting the other one. Use the same
authentication token for both services, or let the interpreter fall back to
`MH_FACE_AUTH_TOKEN`, so the saved Atom credential remains valid.

The interpreter's HTTP bridge checks Atom `/health`, including `ws_connected`
and the configured WebSocket port/path, before advertising microphone
availability. Merely finding a reachable Atom that is connected to a different
custom endpoint does not disable phone PTT. If a deployment explicitly chooses
a non-default port, re-provisioning is required only for that custom endpoint.

An Atom connected to the interpreter owns both input and output. The phone is
display/control only. During actual Atom playback, firmware switches the shared
ES8311 codec away from mic capture. It starts the configured post-playback VAD
cooldown from actual playback completion (`audio_->busy()` becoming false),
not from a predicted audio duration. The fresh-device default is a conservative
1,200 ms; `--vad-playback-cooldown-ms` can tune a particular device down to
200 ms. The application does not add a timer-based phone/Atom mute.

### Atom playback codec and mobile-browser compatibility

Interpreter TTS destined for a capable Atom is converted from mono PCM16 WAV to
standard Microsoft IMA ADPCM WAV on the PC. The Atom advertises
`pcm16_wav`/`ima_adpcm_wav` in its WebSocket endpoint state and `/health`.
`MH_ATOM_TTS_CODEC=auto` (the default) uses ADPCM only when every selected Atom
advertises support; an older or unknown endpoint receives PCM. Use `pcm16` or
`ima_adpcm` only as an explicit troubleshooting override.

The audio store publishes one `tts_audio_ref` for an Atom turn. The HTTP bridge
fetches those compressed bytes and forwards the binary body without expanding
it to Base64 JSON. `audio_id` plus generation deduplication prevents the direct
WebSocket and HTTP bridge paths from playing the same chunk twice. A transient
direct HTTP fetch is retried once.

This codec choice is **Atom-only**. Phone interpreter playback uses a separate
same-origin binary reference containing mono MP3 at a nominal 128 kbit/s,
generated with the same FFmpeg/libmp3lame policy as the working Arcade Music
Player mobile path. It plays through one persistent unlocked HTML audio
element. It does not use WebM/Opus, because iPhone/iPad browsers can reject live
Opus playback even after a positive capability check. If MP3 conversion or
reference storage fails, that utterance alone falls back to direct PCM16.

### Backends: RMS vs Silero

Selected with `MH_ATOM_VAD_BACKEND` (default `rms`):

- **rms** — energy threshold. Snappy boundary, trivial CPU. Fine in a quiet
  room; it does not distinguish speech from loud non-speech.
- **silero** — ML speech/non-speech per frame (~1–3 ms CPU on the worker).
  Rejects street / station / café noise. First-time setup:
  `uv sync --project silero-vad-worker`. The stack auto-starts the worker on
  `:8092` when this backend is selected (`MH_STACK_START_SILERO_VAD`).

Silero is a touch slower at the *boundary* because it classifies a voice's
decay/reverb as speech; in a quiet room RMS actually feels snappier.

### Tuning knobs — PC side (env, no device reboot)

Set these in the shared env file (`~/.config/minimum-headroom.env`) and restart
the stack with `scripts/restart-operator-stack-in-place.sh`:

| Env | Meaning | Typical |
|---|---|---|
| `MH_ATOM_VAD_END_SILENCE_MS` | pause tolerance before a turn ends | 900 snappy … 1800 tolerant |
| `MH_ATOM_VAD_THRESHOLD_RMS` | RMS-backend speech threshold | ~0.01 normal distance; 0.025 mic at mouth |
| `MH_ATOM_VAD_MIN_SPEECH_MS` | min speech before a turn can finalize | ~350 |
| `MH_ATOM_VAD_MAX_UTTERANCE_MS` | hard cap on one continuous utterance | 12000 default; 30000 for long monologues |
| `MH_ATOM_VAD_BACKEND` | `rms` or `silero` | rms |
| `MH_SILERO_VAD_THRESHOLD` | Silero speech-probability threshold | 0.5 |
| `ATOM_HEADROOM_URL` | device HTTP base for TTS playback POST | `http://<device-ip>` |

### Tuning knobs — device side (NVS, reboot to apply)

| Setting / flag | Meaning | Typical |
|---|---|---|
| `vad_rms` (`--vad-rms`) | firmware energy gate; keep **below** the PC threshold | ~0.005 |
| `vad_tail` (`--vad-tail`) | trailing frames that carry the word's decay | 8 (~0.5 s) |
| `vad_encoding` (`--vad-encoding`) | `pcm16` or `ima_adpcm` (4:1) | ima_adpcm for mobile |
| `vad_playback_cooldown_ms` (`--vad-playback-cooldown-ms`) | delay from actual playback end to mic reopen | 1200 safe default; 200 tuned minimum |
| `speaker_volume` (`--speaker-volume`) | saved safe speaker volume, 0–200 | faced 112 indoor; 160 outdoor start; M12 200 |

### Key relationships

- The firmware energy gate and the PC RMS backend use the **identical RMS
  formula**, so both must sit below your actual speaking energy. Keep the
  firmware gate a touch below the PC threshold so onset is not clipped. With the
  shared default 0.025 you had to hold the mic at your mouth.
- **`endSilenceMs` is a pure PC-side knob.** A receive-gap timer in the bridge
  finalizes the turn `endSilenceMs` after the last frame even once the device
  goes silent, so `vad_tail` no longer has to exceed `endSilenceMs` — it only
  carries the decay. Change pause tolerance with env + a stack restart, no
  device reboot.
- `vad_rms > 0` **plus** a non-zero `vad_tail` gives **idle-zero bandwidth**
  (nothing sent while no one talks) **without** chopping an utterance at pauses.

### Bandwidth

Atom-to-PC continuous VAD is about 160 MB/h for Base64-wrapped PCM16 and about
40–50 MB/h for independent-block IMA ADPCM while speech frames are flowing.
With the idle gate (`vad_rms > 0`) it sends nothing between utterances.

PC-to-Atom Supertonic playback at 44.1 kHz is about 882 kB for ten seconds of
PCM16 versus about 223 kB as standard IMA ADPCM WAV. It is sent only while TTS
speaks, and the bridge forwards binary rather than Base64. Use ADPCM in both
directions on a mobile-tethered link. PC-to-browser interpreter speech is about
160 kB per ten seconds as binary MP3. Its old Base64 PCM path would be about
640 kB at 24 kHz or 1.176 MB at 44.1 kHz for the same duration.

### PTT (push-to-talk)

**Long-press the screen button** to talk — PTT bypasses the VAD threshold
entirely and is reliable in any environment, a good fallback when hands-free
tuning is marginal. Wait for the short cue before speaking, then release to
submit. In the separate interpreter it joins the same translation pipeline as
a VAD-finalized turn and leaves the VAD setting unchanged. Screen-button
gestures:

- single tap = VAD off when VAD is on (an escape hatch; persisted). No-op when VAD is already off.
- double tap = VAD on/off toggle — the only on-device way to ENABLE VAD without re-provisioning
- triple tap = IMU auto-upright: snaps the face to the current upright edge and persists it. When the screen faces up (flat, with no upright edge to detect) it falls back to +90° clockwise per triple-tap.
- long press = PTT (while connected). A hold is never counted as a tap, so PTT takes priority and never changes the VAD setting.
- Taps cluster within ~600 ms of each other. If your triple-tap is too slow the taps register separately and a stray single tap can switch VAD off — tap quickly.

### ASR model preload

`ASR_PRELOAD_MODELS=true` loads the model at startup so the first transcription
is instant. Keep `ASR_SINGLE_MODEL_CACHE=true` (the default) to leave VRAM free
for a co-resident local LLM — preload then loads only the default Japanese
model.

### Troubleshooting

- **Encode stream moves but nothing transcribes** — usually a stale bridge
  session after several device reboots without a stack restart. Run
  `scripts/restart-operator-stack-in-place.sh`; the device reconnects clean.
- **VAD silently off** (`vad_on=false` in `RMHCFG?`) — a stray screen single-tap
  disabled it. Re-provision `--vad-on --reboot`. This recurs after flashes too.
- **PC IP changed** (DHCP) — mostly automatic now. The device resolves the PC's
  current IP at boot via **mDNS** (provision `--mdns-host <pc-hostname>.local`),
  rewriting `ws_url` + `http_base` on the home LAN; and the PC-side bridge
  **auto-discovers the device** by `device_id` (`ATOM_HEADROOM_DISCOVERY_SUBNETS`
  adds routed subnets, e.g. a travel router's LAN, so it self-heals as the device
  roams). mDNS does not cross subnets, so keep the static `ws_url`/`http_base`
  fallback pointed at a stable address (e.g. a Tailscale IP) for off-LAN use. If
  the audio WS still goes dark, ask the device which address it settled on with
  `curl http://<device-ip>/health` (`ws_connected` and `face_ws_url`), and check
  from the PC with `ss -tan | grep :8765 | grep -v 127.0.0.1`: no peer at all
  means the device is aiming somewhere else, while rows stuck in `SYN-RECV` mean
  it is aiming here but the reply never gets back — typically a PC with two
  interfaces on one subnet, where the answer leaves by the wrong one. Re-provision
  `--ws-url`/`--http-base` as a manual fallback. Remote
  (Tailscale) use also needs an ACL grant for the device→PC WS — see the
  [Tailscale travel-router guide](tailscale-travel-router-setup.md).
- **TTS plays as white noise / radio static** when your speech and TTS collide —
  an ES8311 ADC→DAC settle race; mitigated by a 30 ms DAC settle after the
  mic→speaker switch. Intermittent.

<a id="japanese"></a>
## 日本語

AtomS3R のハンズフリー音声経路を扱う総合ガイドです。ファームウェアの書き込み、
USB プロビジョニング、VAD による発話区間の判定、RMS / Silero バックエンド、調整項目、
トラブルシューティングをまとめています。
[README](../../README.md) と [Operator Stack ガイド](operator-stack.md#japanese)
は短く保っているので、AtomS3R のセットアップ／調整時はこのファイルを参照してください。

### ハードウェア

- **AtomS3R**（ESP32-S3）＋ **Atomic Echo Base**（ES8311 コーデック）。AtomS3R 本体には
  スピーカーがないため、Echo Base が必要です。ES8311 は**半二重**で、マイク（ADC）と
  スピーカー（DAC）のどちらか一方だけを同時に使えます。
- 書き込み・シリアルプロビジョニングは USB-C 経由（`/dev/ttyACM0`）。

### ファームウェアの書き込み

> ファームウェア本体の詳細は
> [firmware README](../../firmware/atoms3r-headroom/README.md#japanese) を参照してください。
> 特に、ビルド時に自動適用される **WebServer ライブラリパッチ**は、チャンク単位の TTS が
> 各チャンクで約5秒ずつ停滞するのを防ぐために必要です。

```bash
# ビルド
.venv-platformio/bin/pio run -d firmware/atoms3r-headroom

# 書き込み（このボードは --no-stub が必須）
PLATFORMIO_UPLOAD_FLAGS=--no-stub \
  .venv-platformio/bin/pio run -d firmware/atoms3r-headroom -t upload \
  --upload-port /dev/ttyACM0
```

NVS 設定（Wi-Fi・URL・VAD 設定・保存speaker volume）は再書き込みでも保持されます。新規端末の既定値は
`vad_encoding=ima_adpcm` ですが、既存 NVS の `pcm16` は勝手に移行しません。書き込み／
再起動後は `RMHCFG?` で `vad_on` と `vad_encoding` の両方を確認してください。

### リリース用イメージのビルド（メンテナ向け）

通常のビルドでは、`headroom_config.local.h` に記載した Wi-Fi 情報、認証トークン、PC の URL
がバイナリへ直接埋め込まれます。自分の端末だけで使う場合は問題ありませんが、**その
バイナリをコミットしたり共有したりしないでください**。ブラウザからインストールするための
秘密情報を含まないバンドルは、プレースホルダーだけのサンプル設定でビルドします。

```bash
scripts/build-release-firmware.sh        # -> dist/atoms3r-firmware/
```

このスクリプトは example 設定を強制し、**`local.h` の実値が一つでもバイナリへ漏れていれば
ビルドを失敗として停止します**。成功すると、esp-web-tools 用の成果物
（`bootloader.bin`、`partitions.bin`、`boot_app0.bin`、`firmware.bin`）、`manifest.json`、
インストール用の `index.html` を出力します。

実際の Wi-Fi 情報とトークンは端末の NVS に保存され、これらの配布用成果物には含まれません。
書き込み後、後述のセットアップポータルから端末へ設定してください。

### ブラウザ簡易インストール（ツール不要）

`dist/atoms3r-firmware/` フォルダを localhost で配信し、Chromium 系ブラウザで開きます。
esp-web-tools は `manifest.json` と `.bin` を `fetch()` するため、`index.html` をダブルクリックして
`file://` で開いても動きません。`http://localhost` または HTTPS で配信してください。

```bash
cd dist/atoms3r-firmware
python3 -m http.server 8099        # 空いているポートなら何でも可
```

サーバーを起動したら、次の手順でインストールします。

1. **Chrome か Edge**（デスクトップ。Web Serial は Chromium のみ）で `http://localhost:8099/` を開きます。
2. AtomS3R を USB-C で接続します。
3. **Install** を押し、ブラウザのダイアログから端末のシリアルポートを選びます。ポートは
   手動で選びますが、チップの種類は自動判定されます。

> **AtomS3R で検証済み:** CLI では `--no-stub` が必須ですが、esp-web-tools を使えば Chrome から
> このボードへ問題なく書き込めました。特定のボードやポートで動作しない場合は、前述の
> PlatformIO 手順を使ってください。

### Wi-Fi セットアップポータル（CLI 不要）

書き込み後は、追加のツールを使わずに Wi-Fi とサーバー URL を設定できます。

1. **画面ボタンを押しながら電源を入れ**（約2秒）、ポータルを開きます。Wi-Fi が未設定なら、
   ポータルは自動的に起動します。
2. スマートフォンまたは PC から、端末の Wi-Fi アクセスポイント **`RMH-SETUP-XXXX`** に
   接続します。
3. キャプティブ画面が開きます（または AP の IP、通常 `http://192.168.4.1` を開く）。
4. Wi-Fi の SSID とパスワード、Face HTTP base、WebSocket URL を入力します。必要に応じて
   mDNS ホスト、認証トークン、VAD 設定も変更し、**Save** を押して再起動します。

**設定項目:** 必須なのは3項目です。ほかは必要がなければ既定値のまま使えます。

| 項目 | 入れる値 | |
|---|---|---|
| Wi-Fi SSID / password（#1〜#3） | 接続するネットワーク（上から順に試行） | **必須** |
| Face HTTP base / WebSocket URL | PC の `:8765` — `http://<pc>:8765` と `ws://<pc>:8765/ws`。屋外も使うなら安定アドレス（例: Tailscale IP）を指定 | **必須** |
| Auth token | `MH_FACE_AUTH_TOKEN` の値（空だと PC が 401） | **必須** |
| PC mDNS host | 例 `my-pc.local` — 自宅 LAN で PC の IP を自動追従。空で無効 | 任意 |
| **Continuous hands-free VAD**（チェック） | **ハンズフリーにするならチェック**（発話を検出して自動送信）。外すと PTT（長押し）専用。見落とし注意。 | 任意 |
| Firmware VAD RMS threshold | 端末側エネルギーゲート。バックエンドに合わせる：**RMS（既定）→ ~0.025**／**Silero → ~0.005**（低くして PC の Silero に微弱フレームを渡す） | 既定 |
| VAD audio encoding | `ima_adpcm`（新規端末の既定、約4:1）／`pcm16`（互換用） | 既定 |
| Post-playback VAD cooldown | 実再生終了後、共有codecをmicへ戻すまでの待ち時間。1200 msは安全側、対応下限は200 ms | 1200 ms |
| Speaker volume | 安全範囲0〜200。顔Atomは屋内既定112、屋外の出発点160。M12既定200 | 既定 |
| Device ID / agent ID / ASR / TTS / 回転 / pose | 妥当な既定値。必要がなければそのまま | 既定 |

VAD **バックエンド**（RMS / Silero）は PC 側で選択し、**既定は RMS** です。Silero を使う
場合は `silero-vad-worker` を導入し、`MH_ATOM_VAD_BACKEND=silero` を設定します。詳しくは
後述の「バックエンド: RMS と Silero」を参照してください。端末側の
*Firmware VAD RMS threshold* もバックエンドに合わせ、RMS なら約0.025、Silero なら約0.005に
設定します。

### USB プロビジョニング（RMHCFG）

`scripts/atoms3r-provision.mjs` は、Wi-Fi、URL、VAD の設定をシリアル経由で NVS に
書き込みます。Wi-Fi ポータルで手入力する必要はありません。

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --wifi "HomeSSID:pass" --wifi "CafeSSID:pass" \
  --http-base http://<pc-ip>:8765 --ws-url ws://<pc-ip>:8765/ws \
  --mdns-host <pc-hostname>.local \
  --device-id atom-headroom-1 --asr-lang ja \
  --vad-on --vad-rms 0.005 --vad-tail 8 --vad-encoding ima_adpcm \
  --speaker-volume 112 \
  --reboot
```

VAD 関連のフラグは、`--vad-on` / `--vad-off`、`--vad-rms <0..1>`、`--vad-tail <0..240>`、
`--vad-encoding pcm16|ima_adpcm`、`--vad-playback-cooldown-ms <200..5000>`、
`--speaker-volume <0..200>`、`--asr-lang ja|en` です。コーデックの切り替えが安定することが
分かっている半二重の Atom に限り、その端末だけ `--vad-playback-cooldown-ms` を短く設定できます。

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --vad-playback-cooldown-ms 200 --reboot
```

`--mdns-host <PCのホスト名>.local`
を渡すと、デバイスは起動時に PC の現在の IP を解決し、`--ws-url` と `--http-base` のホストを
書き換えます。そのため、DHCP で IP が変わっても再設定は不要です。屋外などで mDNS を解決
できない場合は静的 URL を使うため、そちらには Tailscale IP などの安定したアドレスを設定して
ください。`--mdns-host ""` で無効にできます。PC 側に mDNS レスポンダ（Ubuntu なら
`avahi-daemon`）が必要で、無ければデバイスは静的 URL のままになります。

1 台の PC が 1 つの `.local` 名に対して複数のアドレス（LAN のほか Tailscale や
コンテナブリッジ）を広告することが多いため、デバイスは**すべての回答を集め、自分と同じ
サブネットのものを優先し、採用前に対象ポートへ TCP 接続して疎通を確認**します。届かない
アドレスは黙って掴まずにスキップします。その後 WebSocket が 1 分以上切れたままなら再解決し、
**別のアドレスが疎通確認を通ったときだけ**再起動するので、PC の電源が落ちているだけの
状況で再起動を繰り返すことはありません。現在値を確認するには、115200 baud の
未加工シリアル接続で `RMHCFG?` を送信します。

hostはUSB CDC deviceを一度だけopenし、副作用のない`RMHCFG?`をAtomから
`RMHCFG STATE`が返るまで再送します。firmwareのserial loopがreadyになってから、NVSを
変更する`RMHCFG <json>`を一度だけ送るため、USB nodeの列挙とfirmware readyの競合を
吸収しつつ、NVS書き込みやrebootの重複を防ぎます。環境によってはfirmware reboot後、
Wi-Fi動作が復帰していてもphysical reconnectまで`/dev/ttyACM0`が消えることがあります。

### スピーカー出力音量

音量はTTS波形を増幅するのではなく、Atom上のM5Unified hardware master levelで変更します。
そのためKokoro、SupertonicなどのTTS providerに共通して効き、digital clippingを追加
しません。安全範囲は0〜200です。

- 顔Atomの保存既定値: **112**（現在の屋内音量）。
- `outdoor`: **160**。M5Unifiedの非線形mixing curveでは112比で約+6.2 dB相当ですが、
  屋外での出発点であり保証値ではありません。
- M12の保存既定値: **200**。
- 実機のAtom/Echo Baseでは200超で状態の悪いトランシーバーのような強いノイズが出るため、
  UI、API、CLI、firmwareのすべてで200超を拒否します。

再起動せず、NVSを変更せずに現在だけ変更する例:

```bash
node scripts/atoms3r-volume.mjs --preset outdoor
node scripts/atoms3r-volume.mjs --preset indoor
node scripts/atoms3r-volume.mjs --volume 145
node scripts/atoms3r-volume.mjs --preset mute
```

このcommandは`ATOM_HEADROOM_URL`または`/health`自動探索と、bridgeと同じAtom/face認証
環境を使います。現在値は`/health`の`speaker_volume`に現れ、rebootすると保存baselineへ
戻ります。baseline自体を変更する場合:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --speaker-volume 112 --reboot
```

runtime endpointと`speaker_volume` health fieldには更新済みfirmwareが必要です。旧firmware
ではCLIがflash-first messageを出して停止します。Interpreterのスマホ画面では、対応firmware
接続時だけroute stripにspeaker iconと現在値を表示し、tap時だけ0〜200 slider、±8、
Mute/Indoor/Outdoorを開きます。操作は認証済みsame-origin Interpreter APIから接続中Atomへ
渡し、NVSを変更しません。翻訳本文に含まれる「音量」をdevice commandと誤認しないよう、
広い音声intentは追加していません。

共通Face Appはoperator modeとInterpreter modeの両方で、認証付き
`GET/POST /api/atom/volume`を公開します。coding agent向けMCP serverは、この確認応答付き
制御経路を3つのtarget-safe toolとして包みます。`atom.volume.get`は現在値を読み、
`atom.volume.set`は`volume_percent`で0〜100%の絶対値を設定し、
`atom.volume.adjust`は`up`または`down`へ`percentage_points`だけ変更します（省略時5、
0%と100%でclamp）。MCP resultはmodel向け百分率と診断用raw 0〜200値の両方を返し、
MCPが百分率を2倍したfirmware値へ変換してからFace Appへ送ります。どのcallでも`target: "face"`または
`target: "m12"`が必須です。server側で
`ATOM_HEADROOM_DEVICE_ID`または`MH_M12_DEVICE_ID`へ変換するため、modelが任意の接続deviceや
URLを選ぶことはできません。`MCP_TOOL_NAME_STYLE=underscore`時の公開名は
`atom_volume_get`、`atom_volume_set`、`atom_volume_adjust`です。すべて
`persistent: false`を返し、保存baselineの変更には従来どおりUSB provisioningを使います。
翻訳中の単語だけでは発火せず、対話agentがtarget-safe MCP toolを明示的に選んだ場合だけ
操作されます。

### VAD パイプラインの仕組み

1. **ファームウェア**は、1024 サンプル（64 ms）ずつ音声を取得します。RMS ゲート
   （`vad_rms`）で明らかな無音を捨てて帯域を節約し、最後の発話フレームに続けて
   `vad_tail` 枚の末尾フレームを送り、語尾を切らずに届けます。必要なら
   `vad_encoding` に従って IMA-ADPCM へ圧縮し、`atom_audio_frame` として WebSocket で
   送信します。
2. **PC ブリッジ**（`face-app`）が ADPCM を PCM16 へデコードし、各フレームをバックエンドで
   判定します。ターンを蓄積し、`受信済み無音 + (現在 − 最終フレーム時刻) ≥ endSilenceMs`
   かつ `発話 ≥ minSpeechMs`（または連続発話長が `maxUtteranceMs` に達したとき）に
   **確定**します。後半の「受信ギャップ」の項により、ファームウェア側の tail を短くできます
   （後述）。
3. 確定した PCM16 音声を **ASR ワーカー**（parakeet）へ渡し、文字起こし結果を
   `operator_response` として配送します。ここから先はブラウザマイク経路と同じ流れです。

### 独立した通訳スタックでAtomを使う

通訳は同じframe decoderとVAD区切りを再利用しますが、完成WAVをoperator用Parakeetではなく
provider-neutralな通訳pipelineへ渡します。source languageは通訳providerが自動判定します。
firmwareに保存された `ja` / `en` hintは通訳方向の判定には使いません。旧firmwareでもPCM
互換経路で通訳できますが、PC→Atomの圧縮再生と能力通知には新firmwareが必要です。

物理PTTもこのmodeで使えます。firmwareは互換性のため従来の二段階
`/api/operator/asr` + `operator_response` protocolを維持し、通訳serverがその通信を認識
します。起動presetで選択中のASRを自動言語判定で一度だけ実行し、準備済み結果を通常の
通訳turnへ渡します。firmwareに保存されたASR hintは推論に使いません。operator接続時に
物理PTTが動いているfirmwareなら、この対応のための再書き込みは不要です。

Atomが保持するFace WebSocket接続先は一度に一つです。operatorとinterpreterは同じ
排他port 8765を既定にするため、operatorの8765へ設定済みのAtomはinterpreterへ
切り替える際も接続先を書き換える必要がありません。現在のstackを停止してからもう一方を
起動します。両serviceで同じ認証tokenを使うか、interpreterを`MH_FACE_AUTH_TOKEN`へ
fallbackさせれば、Atomに保存済みのcredentialもそのまま使えます。

通訳側HTTP bridgeはAtom `/health` の`ws_connected`と設定済みWebSocketのport/pathも
確認してからmic利用可能を通知します。明示的に別のcustom endpointへ接続したAtomがHTTPで
見つかっただけではスマホPTTを無効にしません。既定外portを選んだdeploymentだけは、
そのcustom endpointへ再provisionする必要があります。

通訳へ接続中のAtomは入力と出力の両方を担当し、スマホは表示・操作だけです。Atom再生中は
firmwareが共有ES8311 codecをmic captureから切り替えます。設定済みpost-playback cooldownは
予測時間ではなく、`audio_->busy()` がfalseになった実再生終了時点から始まります。新規端末の
安全側既定値は1,200 msで、`--vad-playback-cooldown-ms` により端末ごとに200 msまで短縮
できます。application側にスマホ/Atomを跨ぐtimer-based muteは追加していません。

### Atom再生codecとスマホbrowserの互換性

対応するAtom向けの通訳TTSは、PC上でmono PCM16 WAVから標準Microsoft IMA ADPCM WAVへ
変換します。AtomはWebSocketのendpoint stateと`/health`で
`pcm16_wav` / `ima_adpcm_wav`対応を通知します。既定の
`MH_ATOM_TTS_CODEC=auto`は、選択された全Atomが対応するときだけADPCMを使い、旧firmwareや
能力不明時はPCMへ戻します。`pcm16` / `ima_adpcm`の強制指定は切り分け用です。

Atomの1 turnにつき音声storeが送るのは1つの`tts_audio_ref`です。HTTP bridgeは圧縮済み
byte列を取得し、Base64 JSONへ膨らませずbinary bodyのまま転送します。`audio_id`とgeneration
でdirect WebSocket経路との二重再生を防ぎ、一時的なdirect HTTP失敗時だけ1回再試行します。

このcodec選択は**Atom専用**です。スマホの通訳再生は別の同一origin binary referenceを
使い、Arcade Music Playerの正常動作経路と同じFFmpeg/libmp3lame方針で生成したmono MP3
128 kbit/sを、unlock済みの永続HTML audio elementで再生します。iPhone/iPadでは対応判定が
成功してもlive WebM/Opusが拒否されることがあるため、Opusは使いません。MP3変換または
reference保存に失敗した発話だけdirect PCM16へfallbackします。

### バックエンド: RMS と Silero

`MH_ATOM_VAD_BACKEND`（既定値は `rms`）で選択します。

- **rms** — エネルギーしきい値を使います。境界の判定が速く、CPU 負荷も小さいため、静かな
  部屋には十分です。声と大きな非発話音は区別しません。
- **silero** — フレームごとに ML で発話か非発話かを判定します（ワーカー側で
  1フレームあたり1〜3 ms）。
  路上、駅、カフェなどの環境音に強い方式です。初回だけ
  `uv sync --project silero-vad-worker` を実行してください。このバックエンドを選ぶと、
  スタックが `:8092` でワーカーを自動起動します
  （`MH_STACK_START_SILERO_VAD`）。

Silero は声の余韻も発話と判定するため、**区切りの確定がやや遅くなります**。静かな部屋では、
RMS の方が素早く反応します。

### PC 側の調整（環境変数、デバイスの再起動は不要）

共有の環境設定ファイル（`~/.config/minimum-headroom.env`）へ設定し、
`scripts/restart-operator-stack-in-place.sh` でスタックを再起動します。

| Env | 意味 | 目安 |
|---|---|---|
| `MH_ATOM_VAD_END_SILENCE_MS` | 発話終了と判断するまでの無音時間 | 900 なら速い、1800 ならポーズに寛容 |
| `MH_ATOM_VAD_THRESHOLD_RMS` | RMS バックエンドの発話閾値 | 通常距離 ~0.01 / 口元 0.025 |
| `MH_ATOM_VAD_MIN_SPEECH_MS` | 確定に必要な最小発話長 | ~350 |
| `MH_ATOM_VAD_MAX_UTTERANCE_MS` | 1 連続発話の上限 | 既定 12000 / 長話なら 30000 |
| `MH_ATOM_VAD_BACKEND` | `rms` または `silero` | rms |
| `MH_SILERO_VAD_THRESHOLD` | Silero の発話確率閾値 | 0.5 |
| `ATOM_HEADROOM_URL` | TTS 再生 POST 先（デバイス HTTP） | `http://<device-ip>` |

### デバイス側の調整（NVS、反映には再起動が必要）

| 設定 / フラグ | 意味 | 目安 |
|---|---|---|
| `vad_rms`（`--vad-rms`） | ファーム側エネルギーゲート。PC 閾値より**下**に | ~0.005 |
| `vad_tail`（`--vad-tail`） | 語尾の余韻を運ぶ末尾フレーム数 | 8（~0.5 秒） |
| `vad_encoding`（`--vad-encoding`） | `pcm16` か `ima_adpcm`（4:1） | モバイルは ima_adpcm |
| `vad_playback_cooldown_ms`（`--vad-playback-cooldown-ms`） | 実再生終了からmic再開まで | 安全側既定1200、調整下限200 ms |
| `speaker_volume`（`--speaker-volume`） | 保存する安全なspeaker volume、0〜200 | 顔112屋内／160屋外出発点、M12 200 |

### 重要な関係

- ファームウェアのゲートと PC の RMS バックエンドは**同じ RMS 式**を使うため、両方の
  しきい値を実際の発話エネルギーより低くする必要があります。発話の冒頭を切らないよう、
  ファームウェア側は PC 側より少し低く設定してください。共有既定値の 0.025 では、マイクを
  口元に近づける必要がありました。
- **`endSilenceMs` は PC 側だけの調整値**です。ブリッジの受信ギャップ・タイマーが、
  デバイスが送信を止めても最終フレームから `endSilenceMs` 後に確定するため、`vad_tail`
  は `endSilenceMs` を超える必要がなくなりました（余韻を運ぶだけ）。ポーズ耐性は
  環境変数＋スタック再起動だけで変更でき、デバイス再起動は不要です。
- `vad_rms > 0` と0以外の `vad_tail` を組み合わせると、**待機中は送信しない**ことと、
  **発話中の間を途切れさせない**ことを両立できます。

### 帯域

Atom→PCの連続VADは発話frame送信中、Base64化したPCM16で約160 MB/h、独立block型
IMA-ADPCMで約40〜50 MB/hです。アイドルゲート（`vad_rms > 0`）により発話間は送信しません。

PC→AtomのSupertonic再生（44.1 kHz）は、10秒ならPCM16が約882 kB、標準IMA ADPCM WAVが
約223 kBです。送信はTTS発話中だけで、bridgeはBase64ではなくbinary転送します。モバイル
テザリングではAtomとの双方向にADPCMを使います。PC→browserの通訳音声はbinary MP3で
10秒あたり約160 kBです。従来のBase64 PCMなら同じ10秒で24 kHzが約640 kB、44.1 kHzが
約1.176 MBでした。

### PTT（プッシュ・トゥ・トーク）

**画面ボタンを長押し**して話します。PTT は VAD 閾値を使わないため、周囲の音に左右されにくい
確実な入力方法です。ハンズフリーの調整が難しい場合に使ってください。短い合図音を待って
話し、離すと送信します。独立通訳ではVADで確定した発話と同じ翻訳経路へ合流し、VAD設定は
変えません。画面ボタンには次の操作があります。

- 単タップ: VAD がオンのときにオフへ切り替え、設定を保存します。緊急停止に使えます。
  VAD がオフのときは何もしません。
- ダブルタップ: VAD のオンとオフを切り替えます。再プロビジョニングせず、デバイス上で VAD を
  オンにできる唯一の操作です。
- トリプルタップ: IMU の自動正立を実行します。その時点の上辺に顔を合わせて保存します。
  画面が上向きで正立を判定できない場合は、トリプルタップのたびに時計回りへ +90 度回転します。
- 長押し: 接続中に PTT を使います。長押しはタップに数えないため PTT が優先され、VAD の
  設定は変わりません。
- タップは約 600 ms 以内をひとまとまりとして扱います。トリプルタップの間隔が長いと別々の
  タップと判断され、単タップによって VAD が誤ってオフになることがあります。素早く
  タップしてください。

### ASR モデル先読み

`ASR_PRELOAD_MODELS=true` を設定すると、起動時にモデルを読み込み、初回の文字起こしまでの
待ち時間を短縮できます。
`ASR_SINGLE_MODEL_CACHE=true`（既定）のままにすると、同居するローカル LLM 用に VRAM
を空けておけます（先読みは既定の日本語モデルのみ）。

### トラブルシュート

- **エンコード列は動くのに文字起こしが出ない** — 多くは、スタックを再起動しないまま
  デバイスを何度も再起動したあとに残る、古いブリッジセッションが原因です。
  `scripts/restart-operator-stack-in-place.sh` で解消すると、デバイスが新しいセッションへ
  接続し直します。
- **VAD が勝手にオフ**（`RMHCFG?` で `vad_on=false`）— 画面の単タップで無効化された
  可能性があります。`--vad-on --reboot` を指定して再プロビジョニングしてください。
  ファームウェアを書き込んだ直後にも起こることがあります。
- **PC の IP が変わった**（DHCP）— 通常は自動的に追従します。デバイスは起動時に **mDNS** で
  PC の現在の IP を解決し、`ws_url` と `http_base` を書き換えます。自宅 LAN 用の設定では、
  `--mdns-host <PCのホスト名>.local` を指定してプロビジョニングしてください。
  PC 側ブリッジは `device_id` を使ってデバイスを自動検出します。トラベルルーターの LAN など、
  経路だけが設定されたサブネットは、`ATOM_HEADROOM_DISCOVERY_SUBNETS` で探索対象へ追加できます。
  これにより、端末が移動しても接続を自動的に復旧できます。

  mDNS はサブネットを越えないため、屋外用の静的な `ws_url` / `http_base` には、Tailscale IP
  などの安定したフォールバック先を設定してください。それでも音声 WebSocket が切れる場合は、
  まずデバイス自身にどのアドレスを掴んだか聞きます（`curl http://<デバイスIP>/health` の
  `ws_connected` と `face_ws_url`）。PC 側では `ss -tan | grep :8765 | grep -v 127.0.0.1` を見て、**行が 1 つも
  無ければ**デバイスは別のアドレスを向いており、**`SYN-RECV` のまま並ぶ**ならこちらを向いて
  いるのに応答が返っていません（PC が同一サブネットに 2 つの I/F を持ち、応答が別の I/F から
  出ている典型例）。手動で復旧するには、`--ws-url` / `--http-base` を指定して
  再プロビジョニングします。Tailscale 経由では Atom → PC の WebSocket を許可する ACL も
  必要です。詳しくは[Tailscale トラベルルーター手順](tailscale-travel-router-setup.md)を参照して
  ください。
- **TTS がホワイトノイズ／無線機のような音**になる（発話と TTS がかち合った時）— ES8311
  の ADC → DAC 切り替え時に、安定化待ちが競合している可能性があります。マイクから
  スピーカーへ切り替えたあとに 30 ms の DAC 安定化待ちを入れて緩和していますが、まれに
  発生します。
