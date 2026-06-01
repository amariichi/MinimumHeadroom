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

AtomS3R のハンズフリー音声経路（書き込み・USB プロビジョニング・VAD のターン区切り・
RMS / Silero バックエンド・各チューニング・トラブルシュート）の総合メモです。
[README](../../README.md) と [Operator Stack ガイド](operator-stack.md#japanese)
は短く保っているので、AtomS3R のセットアップ／調整時はこのファイルを参照してください。

### ハードウェア

- **AtomS3R**（ESP32-S3）＋ **Atomic Echo Base**（ES8311 コーデック）。AtomS3R に
  スピーカーは無いので Echo Base 必須。ES8311 は**半二重**で、マイク（ADC）か
  スピーカー（DAC）のどちらか一方のモードしか取れません。
- 書き込み・シリアルプロビジョニングは USB-C 経由（`/dev/ttyACM0`）。

### ファーム書き込み

> ファーム本体の詳細（特にビルド時に自動適用される **WebServer ライブラリパッチ**＝
> チャンク TTS がチャンクごとに約5秒停滞しないために必須）は
> [firmware README](../../firmware/atoms3r-headroom/README.md#japanese) を参照。

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

通常ビルドは `headroom_config.local.h`（あなたの Wi-Fi・認証トークン・PC の URL）を文字列
としてバイナリに焼き込みます。自分の端末用なら問題ありませんが、**そのバイナリを commit
したり共有したりしないでください**。ブラウザインストール用の秘密なしバンドルは、プレース
ホルダの example 設定でビルドします：

```bash
scripts/build-release-firmware.sh        # -> dist/atoms3r-firmware/
```

このスクリプトは example 設定を強制し、**`local.h` の実値が1つでもバイナリに漏れていれば
ビルドを fail で止め**、esp-web-tools 用の成果物（`bootloader.bin`／`partitions.bin`／
`boot_app0.bin`／`firmware.bin`）・`manifest.json`・`index.html` インストールページを出力します。
実 Wi-Fi/トークンは端末の NVS にあり、これら app 成果物には含まれないので、バンドルに
秘密は入りません（書き込み後に端末側で provision。下記セットアップポータル参照）。

### ブラウザ簡易インストール（ツール不要）

`dist/atoms3r-firmware/` フォルダを localhost で配信し、Chromium 系ブラウザで開きます。
esp-web-tools は `manifest.json` と `.bin` を `fetch()` するため、`file://`（index.html を
ダブルクリック）では動かず、`http://localhost`（または HTTPS）が必要です：

```bash
cd dist/atoms3r-firmware
python3 -m http.server 8099        # 空いているポートなら何でも可
```

そのうえで：

1. **Chrome か Edge**（デスクトップ。Web Serial は Chromium のみ）で `http://localhost:8099/` を開く
2. AtomS3R を USB-C で接続
3. **Install** を押し、ブラウザのダイアログから端末のシリアルポートを選ぶ（ポートは手動
   選択、チップ種別は自動判定）

> **AtomS3R で検証済み:** CLI では `--no-stub` が必須ですが、esp-web-tools は Chrome から
> このボードを問題なく書き込めました。特定のボード/ポートで不調なら、上記 PlatformIO
> フローがフォールバックです。

### Wi-Fi セットアップポータル（CLI 不要）

書き込み後、ツールなしで Wi-Fi とサーバ URL を設定できます：

1. ポータルに入る——**画面ボタンを押しながら電源を入れる**（約2秒）。Wi-Fi 未保存なら
   自動で起動します。
2. スマホ/PC から端末の Wi-Fi アクセスポイント **`RMH-SETUP-XXXX`** に接続。
3. キャプティブ画面が開きます（または AP の IP、通常 `http://192.168.4.1` を開く）。
4. Wi-Fi SSID/パスワードと Face HTTP base / WebSocket URL（任意で mDNS host・認証トークン・
   VAD 設定）を入力し、**Save** して再起動。

**項目リファレンス** — 必須は3つだけ。残りは既定のままでOK：

| 項目 | 入れる値 | |
|---|---|---|
| Wi-Fi SSID / password（#1〜#3） | 繋ぐネットワーク（上から順に試行） | **必須** |
| Face HTTP base / WebSocket URL | PC の `:8765` — `http://<pc>:8765` と `ws://<pc>:8765/ws`。屋外も使うなら安定アドレス（例: Tailscale IP）を指定 | **必須** |
| Auth token | `MH_FACE_AUTH_TOKEN` の値（空だと PC が 401） | **必須** |
| PC mDNS host | 例 `my-pc.local` — 自宅LANで PC の IP を自動追従。空で無効 | 任意 |
| **Continuous hands-free VAD**（チェック） | **ハンズフリーにするならチェック**（発話を検出して自動送信）。外すと PTT（長押し）専用。見落とし注意。 | 任意 |
| Firmware VAD RMS threshold | 端末側エネルギーゲート。バックエンドに合わせる：**RMS（既定）→ ~0.025**／**Silero → ~0.005**（低くして PC の Silero に微弱フレームを渡す） | 既定 |
| VAD audio encoding | `pcm16`（既定）／`ima_adpcm`（4:1、モバイル・Silero 向け） | 既定 |
| Device ID / agent ID / ASR / TTS / 回転 / pose | 妥当な既定値。必要が無ければそのまま | 既定 |

VAD **バックエンド**（RMS / Silero）は PC 側の選択で、**既定は RMS**。Silero は opt-in
（`silero-vad-worker` を導入し `MH_ATOM_VAD_BACKEND=silero`。下の *バックエンド: RMS と
Silero* 参照）。端末側の *Firmware VAD RMS threshold* はバックエンドに合わせる（RMS≈0.025／
Silero≈0.005）。

### USB プロビジョニング（RMHCFG）

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 \
  --wifi "HomeSSID:pass" --wifi "CafeSSID:pass" \
  --http-base http://<pc-ip>:8765 --ws-url ws://<pc-ip>:8765/ws \
  --mdns-host <pc-hostname>.local \
  --device-id atom-headroom-1 --asr-lang ja \
  --vad-on --vad-rms 0.005 --vad-tail 8 --vad-encoding ima_adpcm \
  --reboot
```

VAD 系フラグ: `--vad-on` / `--vad-off`、`--vad-rms <0..1>`、`--vad-tail <0..240>`、
`--vad-encoding pcm16|ima_adpcm`、`--asr-lang ja|en`。`--mdns-host <PCのホスト名>.local`
を渡すと、デバイスが起動時に PC の現 IP を解決して `--ws-url`/`--http-base` のホストを
書き換えるので、DHCP 変動でも再プロビジョン不要になります。mDNS が解決できない場合
（屋外など）は静的 URL にフォールバックするので、そちらは安定アドレス（例: Tailscale IP）
にしておきます。`--mdns-host ""` で無効化。現在値はシリアルに `RMHCFG?`（115200, raw）を
送れば取得できます。

### VAD パイプラインの仕組み

1. **ファーム**は 1024 サンプル（64 ms）フレームを取得。RMS ゲート（`vad_rms`）で
   真の無音を捨てて帯域節約し、最後の発話フレームのあと `vad_tail` 枚の末尾フレーム
   を送って語尾の余韻を運びます。必要なら IMA-ADPCM 圧縮（`vad_encoding`）して
   `atom_audio_frame` を WebSocket で送信。
2. **PC ブリッジ**（`face-app`）がデコード（ADPCM→PCM16）し、各フレームをバックエンド
   で判定、ターンを蓄積して、`受信済み無音 + (現在 − 最終フレーム時刻) ≥ endSilenceMs`
   かつ `発話 ≥ minSpeechMs`（または `≥ maxUtteranceMs`）で**確定**します。後半の
   「受信ギャップ」項のおかげでファームの tail を短くできます（後述）。
3. 確定 PCM16 は **ASR ワーカー**（parakeet）へ、文字起こしは `operator_response`
   として配送。ブラウザマイク経路と同じ流れです。

### バックエンド: RMS と Silero

`MH_ATOM_VAD_BACKEND`（既定 `rms`）で選択:

- **rms** — エネルギー閾値。境界の判定が速く CPU も軽い。静かな部屋なら十分。声と
  大きな非発話音は区別しません。
- **silero** — フレーム毎に ML で speech/非 speech 判定（ワーカー側 1〜3 ms/フレーム）。
  路上・駅・カフェの環境音に強い。初回のみ `uv sync --project silero-vad-worker`。
  このバックエンド選択時はスタックが `:8092` でワーカーを自動起動します
  （`MH_STACK_START_SILERO_VAD`）。

Silero は声の余韻も speech と判定するため**境界がやや遅め**。静かな部屋ではむしろ
RMS の方がキビキビします。

### チューニング — PC 側（env、デバイス再起動不要）

共有 env ファイル（`~/.config/minimum-headroom.env`）に設定し、
`scripts/restart-operator-stack-in-place.sh` でスタック再起動:

| Env | 意味 | 目安 |
|---|---|---|
| `MH_ATOM_VAD_END_SILENCE_MS` | ターン終了までの間（ポーズ耐性） | 900 速い … 1800 寛容 |
| `MH_ATOM_VAD_THRESHOLD_RMS` | RMS バックエンドの発話閾値 | 通常距離 ~0.01 / 口元 0.025 |
| `MH_ATOM_VAD_MIN_SPEECH_MS` | 確定に必要な最小発話長 | ~350 |
| `MH_ATOM_VAD_MAX_UTTERANCE_MS` | 1 連続発話の上限 | 既定 12000 / 長話なら 30000 |
| `MH_ATOM_VAD_BACKEND` | `rms` または `silero` | rms |
| `MH_SILERO_VAD_THRESHOLD` | Silero の発話確率閾値 | 0.5 |
| `ATOM_HEADROOM_URL` | TTS 再生 POST 先（デバイス HTTP） | `http://<device-ip>` |

### チューニング — デバイス側（NVS、反映に再起動）

| 設定 / フラグ | 意味 | 目安 |
|---|---|---|
| `vad_rms`（`--vad-rms`） | ファーム側エネルギーゲート。PC 閾値より**下**に | ~0.005 |
| `vad_tail`（`--vad-tail`） | 語尾の余韻を運ぶ末尾フレーム数 | 8（~0.5 秒） |
| `vad_encoding`（`--vad-encoding`） | `pcm16` か `ima_adpcm`（4:1） | モバイルは ima_adpcm |

### 重要な関係

- ファームのゲートと PC の RMS バックエンドは**同一の RMS 式**なので、両方とも実際の
  発話エネルギーより下に置く必要があります。立ち上がりを切らないよう、ファーム側は
  PC 閾値より少し下に。共有既定の 0.025 だとマイクを口元に近づける必要がありました。
- **`endSilenceMs` は PC 側だけのノブ**です。ブリッジの受信ギャップ・タイマーが、
  デバイスが送信を止めても最終フレームから `endSilenceMs` 後に確定するため、`vad_tail`
  は `endSilenceMs` を超える必要がなくなりました（余韻を運ぶだけ）。ポーズ耐性は
  env ＋スタック再起動だけで変更でき、デバイス再起動は不要です。
- `vad_rms > 0` ＋ 非ゼロの `vad_tail` で、**待機中は送信ゼロ**かつ**ポーズで途切れ
  ない**を両立します。

### 帯域

ストリーミング中、生 PCM16 は約 160 MB/h、IMA-ADPCM（4:1）は約 40〜50 MB/h。アイドル
ゲート（`vad_rms > 0`）により発話の合間は送信が止まるので、ほぼ無言なら ≈0。屋外・
モバイル回線では **ADPCM ＋ Silero** を推奨。

### PTT（プッシュ・トゥ・トーク）

**画面ボタン長押し**で発話。PTT は VAD 閾値を介さないので、どんな環境でも確実です。
ハンズフリーの調整が微妙なときの代替に。画面ボタンのジェスチャ:

- 単タップ = VAD がオンのときオフ（緊急停止・永続化）。オフ時は無操作。
- ダブルタップ = VAD オン/オフ トグル（再プロビジョンせずデバイス上で VAD をオンにできる唯一の操作）
- トリプルタップ = IMU 自動正立：その時の上辺に顔を合わせて保存。画面が上向き（水平で正立判定できない）ときは +90° 時計回りのフォールバック。
- 長押し = PTT（接続時）。長押しはタップに数えられないので PTT が優先され、VAD 設定は変えません。
- タップは約 600ms 以内で1まとまり。トリプルタップが間延びすると別々のタップ扱いになり、単タップで VAD が誤オフすることがあります（素早くタップ）。

### ASR モデル先読み

`ASR_PRELOAD_MODELS=true` で起動時にモデルをロードし、初回の文字起こしを即応に。
`ASR_SINGLE_MODEL_CACHE=true`（既定）のままにすると、同居するローカル LLM 用に VRAM
を空けておけます（先読みは既定の日本語モデルのみ）。

### トラブルシュート

- **エンコード列は動くのに文字起こしが出ない** — 多くはデバイスを何度も再起動した後の
  ブリッジセッション古化。`scripts/restart-operator-stack-in-place.sh` で解消、デバイス
  はクリーンに再接続します。
- **VAD が勝手にオフ**（`RMHCFG?` で `vad_on=false`）— 画面の単タップで無効化された
  状態。`--vad-on --reboot` で再プロビジョン。書き込み後にも起きがちです。
- **PC の IP が変わった**（DHCP）— 今はほぼ自動です。デバイスは起動時に **mDNS** で PC の
  現 IP を解決して `ws_url`＋`http_base` を書き換え（`--mdns-host <PCのホスト名>.local` で
  プロビジョン、自宅 LAN 用）、PC 側 bridge は `device_id` で**デバイスを自動発見**
  （`ATOM_HEADROOM_DISCOVERY_SUBNETS` で routed なサブネット＝トラベルルーター LAN 等を
  探索対象に追加、端末が移動しても自己修復）。mDNS はサブネットを越えないので、屋外用に
  静的 `ws_url`/`http_base` のフォールバックは安定アドレス（例: Tailscale IP）にしておき
  ます。それでも音声 WS が切れるときは PC 側で
  `ss -tn state established | grep :8765 | grep -v 127.0.0.1`（peer 無し＝断）を確認し、
  手動フォールバックとして `--ws-url`/`--http-base` を再プロビジョン。リモート（Tailscale）
  では Atom→PC の WS に ACL 許可も必要 —
  [Tailscale トラベルルーター手順](tailscale-travel-router-setup.md) を参照。
- **TTS がホワイトノイズ／無線機のような音**になる（発話と TTS がかち合った時）— ES8311
  の ADC→DAC 切替の settle レース。マイク→スピーカー切替後に 30 ms の DAC settle を入れて
  緩和済み。間欠的。
