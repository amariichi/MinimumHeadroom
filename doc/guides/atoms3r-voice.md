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

NVS settings (Wi-Fi, URLs, VAD config) survive a reflash. After any flash or
reboot, re-confirm `vad_on` (see troubleshooting) since a stray screen tap can
disable it.

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
| VAD audio encoding | `pcm16` (default) or `ima_adpcm` (4:1, for mobile / Silero) | default |
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
  --reboot
```

VAD-related flags: `--vad-on` / `--vad-off`, `--vad-rms <0..1>`,
`--vad-tail <0..240>`, `--vad-encoding pcm16|ima_adpcm`, `--asr-lang ja|en`.
`--mdns-host <pc-hostname>.local` makes the device resolve the PC's current IP at
boot and rewrite the host in `--ws-url`/`--http-base`, so a DHCP change needs no
re-provisioning; it falls back to the static URLs when mDNS can't resolve (e.g.
off-LAN — keep those pointed at a stable address such as a Tailscale IP).
`--mdns-host ""` disables it. Read current state by sending `RMHCFG?` over the
serial port (115200, raw).

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

Raw PCM16 is ~160 MB/h while streaming; IMA-ADPCM (4:1) is ~40–50 MB/h. With the
idle gate (`vad_rms > 0`) the stream stops between utterances, so a mostly-idle
device sends ≈0. Use **ADPCM + Silero** outdoors on a mobile-tethered link.

### PTT (push-to-talk)

**Long-press the screen button** to talk — PTT bypasses the VAD threshold
entirely and is reliable in any environment, a good fallback when hands-free
tuning is marginal. Screen-button gestures:

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
  the audio WS still goes dark, check from the PC with
  `ss -tn state established | grep :8765 | grep -v 127.0.0.1` (no peer = audio WS
  down) and re-provision `--ws-url`/`--http-base` as a manual fallback. Remote
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

NVS 設定（Wi-Fi・URL・VAD 設定）は再書き込みでも保持されます。書き込み／再起動の
あとは `vad_on` を再確認してください（画面の不意のタップで無効になることがある）。

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
| VAD audio encoding | `pcm16`（既定）／`ima_adpcm`（4:1、モバイル・Silero 向け） | 既定 |
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
  --reboot
```

VAD 関連のフラグは、`--vad-on` / `--vad-off`、`--vad-rms <0..1>`、`--vad-tail <0..240>`、
`--vad-encoding pcm16|ima_adpcm`、`--asr-lang ja|en`。`--mdns-host <PCのホスト名>.local`
を渡すと、デバイスは起動時に PC の現在の IP を解決し、`--ws-url` と `--http-base` のホストを
書き換えます。そのため、DHCP で IP が変わっても再設定は不要です。屋外などで mDNS を解決
できない場合は静的 URL を使うため、そちらには Tailscale IP などの安定したアドレスを設定して
ください。`--mdns-host ""` で無効にできます。現在値を確認するには、115200 baud の
未加工シリアル接続で `RMHCFG?` を送信します。

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

ストリーミング中の転送量は、生の PCM16 で約160 MB/h、IMA-ADPCM（4:1）で約40〜50 MB/h
です。アイドルゲート（`vad_rms > 0`）により発話の合間は送信を止めるため、ほぼ無言なら
転送量もほぼゼロです。屋外やモバイル回線では **ADPCM ＋ Silero** を推奨します。

### PTT（プッシュ・トゥ・トーク）

**画面ボタンを長押し**して話します。PTT は VAD 閾値を使わないため、周囲の音に左右されにくい
確実な入力方法です。ハンズフリーの調整が難しい場合に使ってください。画面ボタンには次の
操作があります。

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
  PC 側で `ss -tn state established | grep :8765 | grep -v 127.0.0.1` を実行します。接続相手が
  表示されなければ切断中です。手動で復旧するには、`--ws-url` / `--http-base` を指定して
  再プロビジョニングします。Tailscale 経由では Atom → PC の WebSocket を許可する ACL も
  必要です。詳しくは[Tailscale トラベルルーター手順](tailscale-travel-router-setup.md)を参照して
  ください。
- **TTS がホワイトノイズ／無線機のような音**になる（発話と TTS がかち合った時）— ES8311
  の ADC → DAC 切り替え時に、安定化待ちが競合している可能性があります。マイクから
  スピーカーへ切り替えたあとに 30 ms の DAC 安定化待ちを入れて緩和していますが、まれに
  発生します。
