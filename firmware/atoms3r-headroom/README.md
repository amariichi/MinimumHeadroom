# Real Minimum Headroom AtomS3R Firmware

[English](#english) | [日本語](#japanese)

<a id="english"></a>

## English

---

This PlatformIO project is the AtomS3R hardware frontend for minimum-headroom.

## Hardware

This firmware targets the following M5Stack products:

- **M5Stack AtomS3R** — ESP32-S3 controller with 0.85" LCD and 6-axis IMU.
  <https://docs.m5stack.com/en/core/AtomS3R>
- **M5Stack Atomic Echo Base** — speaker + microphone base with ES8311 codec.
  <https://docs.m5stack.com/en/atom/Atomic%20Echo%20Base>

The Atomic Echo Base is required: AtomS3R has no built-in speaker or microphone,
and the firmware drives the ES8311 codec on the Echo Base for both TTS playback
and push-to-talk recording.

Features:

- 128x128 parametric face rendered on the AtomS3R LCD, driven by `event` /
  `tts_state` / `tts_mouth` payloads from face-app over WebSocket.
- Local TTS playback through the Atomic Echo Base speaker.
- Push-to-talk: hold the screen button while connected to Wi-Fi, speak, and
  release to send the recorded WAV through face-app operator ASR.
- Wi-Fi setup access point (`RMH-SETUP-xxxx`) and on-device captive portal,
  plus optional USB-CDC provisioning from the PC.
- Triple-tap-to-reorient and IMU-based auto-rotation so the face stays upright
  when you physically turn the device.

## Build

```bash
cd firmware/atoms3r-headroom
pio run
```

The first build prints `[webserver-patch] applied: …` once, then
`[webserver-patch] already applied: …` on every later build. See
[WebServer library patch](#webserver-library-patch) for what this is and why
it is required.

## WebServer library patch

The Arduino ESP32 core's `WebServer` library has a behavior that adds a fixed
~5 second tail to every audio POST on this firmware. Without the patch, chunked
TTS playback chops noticeably because each chunk waits 5 s for an HTTP response
that should take ~30 ms.

**Root cause.** The raw-upload loop in
`framework-arduinoespressif32/libraries/WebServer/src/Parsing.cpp` reads
`HTTP_RAW_BUFLEN` (1436) bytes per iteration regardless of how many body bytes
remain. The final iteration almost always asks for more than is left, so
`WiFiClient::readBytes` blocks waiting for bytes that will never arrive until
`HTTP_MAX_SEND_WAIT` (5000 ms) elapses.

**Fix.** Cap each `readBytes` request to the actual remaining body bytes so the
last read returns immediately.

**How it is applied.** A pre-build PlatformIO hook
(`scripts/apply_webserver_patch.py`, registered as `extra_scripts` in
`platformio.ini`) edits the system library file in place. The hook is
idempotent (it self-marks with a `PATCH(minimum-headroom):` comment) and fails
loudly if the upstream library no longer matches the expected snippet, so a
framework upgrade cannot silently regress the fix.

**The patch itself.** Equivalent unified diff at
`patches/webserver_raw_read_cap.patch`:

```diff
       while (_currentRaw->totalSize < _clientContentLength) {
-        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, HTTP_RAW_BUFLEN);
+        // PATCH(minimum-headroom): cap readBytes() to remaining bytes so the
+        // final partial chunk does not wait the full 5s WiFiClient timeout.
+        size_t toRead = HTTP_RAW_BUFLEN;
+        size_t remaining = _clientContentLength - _currentRaw->totalSize;
+        if (remaining < toRead) toRead = remaining;
+        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, toRead);
         _currentRaw->totalSize += _currentRaw->currentSize;
```

To apply by hand instead of relying on the hook:

```bash
FW=$(pio pkg show framework-arduinoespressif32 --json-output 2>/dev/null \
  | python -c "import json,sys;print(json.load(sys.stdin)['__pkg_dir'])")
patch -p0 -d "$FW/libraries/WebServer/src" \
  < firmware/atoms3r-headroom/patches/webserver_raw_read_cap.patch
```

To undo (e.g. after upgrading the framework package, which will overwrite the
patched file with the upstream version), simply rerun `pio run` and the hook
will reapply the patch.

Measured effect on this firmware: audio POST round-trip for a 30 KB chunk drops
from ~5.17 s to ~0.18 s; 180 KB drops from ~5.58 s to ~0.68 s. End-to-end
chunked TTS plays smoothly instead of choppy.

## Flash

Put the AtomS3R in download mode if needed, then run:

```bash
pio run -t upload
pio device monitor
```

On the current AtomS3R hardware, flashing may require the esptool no-stub path:

```bash
PLATFORMIO_UPLOAD_FLAGS=--no-stub pio run -t upload --upload-port /dev/ttyACM0
```

Expected serial output:

```text
Real Minimum Headroom AtomS3R starting
display ready
demo face mode
```

Press the Atom button to cycle through neutral, thinking, speaking, listening,
permission, success, and failed expressions.

## Enter the setup portal

The on-device setup portal can be entered in two ways:

1. **Automatic.** When no Wi-Fi credentials are saved, or all configured Wi-Fi
   slots fail to connect at boot, the firmware falls back to the setup AP
   automatically. This is the normal flow for a brand-new device.
2. **Forced (hold screen button at boot).** With a working configuration
   already saved, press and hold the AtomS3R screen button **before** powering
   it on (e.g. hold the button while plugging in USB-C), keep holding for
   about **2 seconds** until the face turns to the *Permission* expression,
   then release. The firmware skips the Wi-Fi connect attempt and starts the
   setup AP. Use this to change Wi-Fi or server URLs without reflashing.

When the setup portal is up, the Atom starts a Wi-Fi access point such as
`RMH-SETUP-1A2B` and shows the SSID plus `192.168.4.1` on the display.
Connect to that AP from a phone or PC and open:

```text
http://192.168.4.1/
```

The setup page saves Wi-Fi, face app URLs, auth token, device id, display
priority agent id, input target agent id, ASR language, face rotation, placement
pose, and upper-side orientation to ESP32 NVS/Preferences.

## Multiple Wi-Fi networks (up to 3)

The firmware stores three Wi-Fi slots. At boot it tries slot 1, then slot 2,
then slot 3 (listed priority, ~8 s each) and connects to the first that works;
only if all configured slots fail does it fall back to the `RMH-SETUP-xxxx`
portal. Empty slots are skipped. Slot 1 keeps the original NVS keys, so an
already-provisioned device needs no migration. The setup portal exposes
"Wi-Fi SSID 2/3" and "Wi-Fi password 2/3".

## Reorient the face without a PC (triple-tap)

Tap the screen button **three times quickly** (each tap shorter than ~0.35 s,
within ~0.6 s of each other) to re-align the "up" direction. The new
orientation is saved to NVS and survives a power cycle, so you can physically
turn the device and re-align the face with no PC, portal, or reflash.

- **Screen tilted / standing up:** the IMU auto-detects which screen edge is
  up and snaps the face to the nearest of the 4 orientations.
- **Lying flat on a desk (screen up):** "up" is undecidable from gravity, so
  each triple-tap just steps the face +90° clockwise (keep tapping to reach
  the orientation you want).

The accelerometer-axis-to-panel mapping needs a one-time on-device
calibration. The easiest way (no reboot, no button) is the serial query:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --dry-run   # (any RMHCFG? client works)
# or send a raw `RMHCFG?\n` line; the STATE reply now includes:
#   "imu_enabled":true,"imu_ax":..,"imu_ay":..,"imu_az":..
```

Hold the device in each of the 4 intended uprights, read `imu_ax`/`imu_ay`
each time, and set `kImuRotationOffsetDeg` / `kImuRotationSign` in
`src/main.cpp` so the snapped angle matches the desired `rotation`. (The boot
log also prints `imu_enabled=...`, and each triple-tap prints
`imu accel x=.. y=.. z=.. inplane=..`, but the serial `RMHCFG?` path is
simpler.) Until calibrated, the flat-desk +90 step always works as a manual
fallback.

Hardware-verified 2026-05-19: `imu_enabled:true` with sane live accel on the
real AtomS3R; multi-slot Wi-Fi connect and the `RMHCFG` serial protocol work
on-device. The gesture *feel*, the audible cue, and the final calibration
constants still need a person at the device.

Push-to-talk is unchanged in feel but now **arms on a ~0.5 s hold** instead of
the press edge: hold the button, you hear a short "ピッ" cue the moment
recording arms, then speak. The beep is the "speak now" signal, so the short
arming delay does not clip your speech. Because a tap is shorter than the PTT
arm time, taps never open the microphone and a stray single tap no longer
flashes the Failed face. (Internally the cue tone is fully drained before the
shared ES8311 codec is switched to the mic, so the documented record/playback
corruption hazard is not reintroduced.)

## PC provisioning over USB (no portal typing)

With the AtomS3R plugged into the PC by USB-C, push Wi-Fi (×3), auth token,
and server URLs in one command instead of typing them into the portal:

```bash
node scripts/atoms3r-provision.mjs \
  --wifi "HomeSSID:homepass" --wifi "CafeSSID:cafepass" \
  --http-base http://192.168.1.10:8765 \
  --ws-url ws://192.168.1.10:8765/ws \
  --device-id atom-headroom-1 --reboot
```

The auth token is resolved automatically from `--token`, else
`MH_FACE_AUTH_TOKEN` in the environment, else the shared env file
`${MH_SHARED_ENV_FILE:-$HOME/.config/minimum-headroom.env}` — i.e. the
same source the running operator stack uses, so no extra setup is needed when
the stack is up. The script needs no npm dependency (it uses `stty` + the
device file). `--dry-run` prints the exact payload with secrets redacted and
never opens the port; `--help` lists all flags.

Under the hood the host and firmware exchange newline-terminated `RMHCFG`
lines on the existing USB CDC serial. `RMHCFG <json>` writes settings to NVS
(optional `"reboot":true`); `RMHCFG?` returns the current config with
passwords/token redacted to lengths only. The firmware listens for these at
any time in `loop()`, including while the setup portal is up.

When Wi-Fi connects successfully, the firmware opens the configured WebSocket
URL and mirrors these minimum-headroom payloads:

- `event`: changes expression for command start, success, failure, permission,
  retry, and idle states.
- `tts_state`: shows queued/speaking/error/idle state.
- `tts_mouth`: drives mouth openness from the payload's `open` value.

When Wi-Fi is connected, the Atom button is used for push-to-talk instead of the
offline expression demo. Hold the button to record up to 8 seconds of 16 kHz mono
PCM from the Atomic Echo Base microphone. On release, the firmware wraps the clip
as `audio/wav`, posts it to:

```text
<Face HTTP base>/api/operator/asr?lang=<ASR language>
```

If ASR returns non-empty text, the Atom sends an `operator_response` websocket
payload with `source: "atom"` and `response_kind: "text"`. If the Atom-to-PC
WebSocket is unavailable, it falls back to authenticated HTTP:

```text
<Face HTTP base>/api/operator/response
```

Recording and speaker playback are serialized because the Atomic Echo Base uses
one ES8311 codec for both mic and speaker.

The normal-mode health endpoint is useful for desk debugging:

```text
http://<atom-ip>/health
```

It reports the configured face HTTP/WS URLs, ASR language, auth presence, and
whether the Atom-originated WebSocket is connected. The auth token value is not
returned.

If `MH_FACE_AUTH_TOKEN` is enabled on the PC, set the same token in the setup
page. The firmware appends it as `auth_token` on the WebSocket URL for the
same-LAN first implementation.

The default display priority agent is `__operator__`. TTS/status payloads from
other agents are still accepted, but recent operator payloads get a short
priority window so helper speech does not immediately overwrite the physical
operator face. Future Atom input payloads should target `__operator__` by
default and must not directly target helper panes unless explicitly configured.

## Local Settings

The checked-in `include/headroom_config.example.h` contains safe placeholders.
For development-only defaults, create `include/headroom_config.local.h`; it is
ignored by git. Runtime settings are loaded from NVS/Preferences when present,
and the Atom-hosted setup portal can update Wi-Fi, server URL, auth token, ASR
language, and orientation without reflashing.

<a id="japanese"></a>

## 日本語

---

minimum-headroom 用の AtomS3R ハードウェアフロントエンド (PlatformIO プロジェクト) です。

## ハードウェア

このファームウェアは以下の M5Stack 製品を対象としています。

- **M5Stack AtomS3R** — ESP32-S3 コントローラ、0.85 インチ LCD、6 軸 IMU 搭載。
  <https://docs.m5stack.com/en/core/AtomS3R>
- **M5Stack Atomic Echo Base** — ES8311 コーデックを搭載したスピーカー + マイクのベース。
  <https://docs.m5stack.com/en/atom/Atomic%20Echo%20Base>

Atomic Echo Base は必須です。AtomS3R 本体にはスピーカーもマイクも無く、本ファームウェアは TTS 再生・PTT 録音のいずれも Echo Base 上の ES8311 コーデック経由で行います。

主な機能:

- AtomS3R の LCD に 128x128 のパラメトリックな顔を描画。face-app からの `event` / `tts_state` / `tts_mouth` ペイロードを WebSocket 経由で受け取って駆動します。
- Atomic Echo Base のスピーカーによるローカル TTS 再生。
- プッシュ・トゥ・トーク: Wi-Fi 接続中にスクリーンボタンを長押しして話し、離すと録音した WAV を face-app のオペレータ ASR へ送信します。
- Wi-Fi セットアップ用アクセスポイント (`RMH-SETUP-xxxx`) によるオンデバイスのキャプティブポータル。必要に応じて PC からの USB-CDC プロビジョニングにも対応。
- トリプルタップによる向きの再調整、および IMU による自動回転で、デバイスを物理的に回しても顔が正立を保ちます。

## ビルド

```bash
cd firmware/atoms3r-headroom
pio run
```

初回ビルドで `[webserver-patch] applied: …` が一度だけ出力され、以降は
`[webserver-patch] already applied: …` になります。これが何で、なぜ必要かは
[WebServer ライブラリパッチ](#webserver-ライブラリパッチ)を参照してください。

## WebServer ライブラリパッチ

Arduino ESP32 コアの `WebServer` ライブラリには、本ファームウェアの音声 POST
ごとに固定で約 5 秒の遅延を生むふるまいがあります。パッチを当てないと、
チャンク TTS 再生がはっきり途切れます(本来 30 ms で返るはずの HTTP 応答を
チャンクごとに 5 秒待つため)。

**原因。** `framework-arduinoespressif32/libraries/WebServer/src/Parsing.cpp`
の生ボディアップロードループは、残りバイト数に関係なく毎回 `HTTP_RAW_BUFLEN`
(1436) バイトを要求します。最後の周回はほぼ常に残量より大きな要求になり、
`WiFiClient::readBytes` は来ないバイトを `HTTP_MAX_SEND_WAIT` (5000 ms) 経過まで
待ち続けます。

**修正。** `readBytes` の要求量を実残量にキャップし、最後の読み取りが即座に
戻るようにします。

**適用方法。** PlatformIO の pre-build フック
(`scripts/apply_webserver_patch.py` を `platformio.ini` の `extra_scripts` に
登録)が、システムライブラリのファイルを直接書き換えます。フックは冪等で
(`PATCH(minimum-headroom):` という自己マーカーを残します)、上流のライブラリが
想定スニペットを失っていれば明示的に失敗します。フレームワーク更新で
修正が黙って消えることはありません。

**パッチ本体。** `patches/webserver_raw_read_cap.patch` と等価:

```diff
       while (_currentRaw->totalSize < _clientContentLength) {
-        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, HTTP_RAW_BUFLEN);
+        // PATCH(minimum-headroom): cap readBytes() to remaining bytes so the
+        // final partial chunk does not wait the full 5s WiFiClient timeout.
+        size_t toRead = HTTP_RAW_BUFLEN;
+        size_t remaining = _clientContentLength - _currentRaw->totalSize;
+        if (remaining < toRead) toRead = remaining;
+        _currentRaw->currentSize = client.readBytes(_currentRaw->buf, toRead);
         _currentRaw->totalSize += _currentRaw->currentSize;
```

フックに頼らず手動で当てるには:

```bash
FW=$(pio pkg show framework-arduinoespressif32 --json-output 2>/dev/null \
  | python -c "import json,sys;print(json.load(sys.stdin)['__pkg_dir'])")
patch -p0 -d "$FW/libraries/WebServer/src" \
  < firmware/atoms3r-headroom/patches/webserver_raw_read_cap.patch
```

フレームワーク更新でパッチ済みファイルが上流版に戻った場合は、`pio run` を
再実行すればフックが再適用します。

このファームでの実測効果: 30 KB チャンクの音声 POST 往復が約 5.17 秒 → 約
0.18 秒、180 KB は約 5.58 秒 → 約 0.68 秒。チャンク TTS が途切れず滑らかに
再生されるようになります。

## 書き込み

必要に応じて AtomS3R をダウンロードモードにしてから実行します。

```bash
pio run -t upload
pio device monitor
```

現行の AtomS3R ハードでは、esptool の no-stub パスが必要なことがあります。

```bash
PLATFORMIO_UPLOAD_FLAGS=--no-stub pio run -t upload --upload-port /dev/ttyACM0
```

期待されるシリアル出力:

```text
Real Minimum Headroom AtomS3R starting
display ready
demo face mode
```

Atom ボタンを押すと、neutral / thinking / speaking / listening / permission / success / failed の各表情を順に切り替えます。

## セットアップポータルの起動方法

オンデバイスのセットアップポータルは次の 2 通りで起動できます。

1. **自動起動。** Wi-Fi 認証情報が未保存の場合、または起動時に設定済みの全 Wi-Fi スロットへの接続に失敗した場合、ファームウェアは自動的にセットアップ用 AP にフォールバックします。新品デバイスの通常フローはこれです。
2. **強制起動 (起動時にスクリーンボタン長押し)。** すでに有効な設定が保存されている状態で設定を変えたいときは、AtomS3R の電源を入れる **前** にスクリーンボタンを押し、押したまま電源を投入します (USB-C を挿しながらボタンを押し続けるイメージ)。顔が *Permission* 表情に変わるまで **約 2 秒** 押し続けてから離します。ファームウェアは Wi-Fi 接続試行をスキップして直接セットアップ AP を起動します。Wi-Fi やサーバ URL を再書き込みなしで変更したいときに使います。

セットアップポータル起動中、Atom は `RMH-SETUP-1A2B` のような Wi-Fi アクセスポイントを立て、ディスプレイに SSID と `192.168.4.1` を表示します。スマホや PC からその AP に接続して以下を開きます。

```text
http://192.168.4.1/
```

セットアップページでは Wi-Fi、face app の URL、認証トークン、デバイス ID、表示優先エージェント ID、入力ターゲットエージェント ID、ASR 言語、顔の回転、設置姿勢、上方向の向きを ESP32 の NVS/Preferences に保存します。

## 複数の Wi-Fi ネットワーク (最大 3 つ)

ファームウェアは Wi-Fi スロットを 3 つ保持します。起動時にスロット 1 → 2 → 3 の順 (記載順、各 ~8 秒) で接続を試み、最初に成功したものに接続します。設定済みスロットがすべて失敗したときだけ `RMH-SETUP-xxxx` ポータルにフォールバックします。空のスロットはスキップされます。スロット 1 は元の NVS キーをそのまま使うため、既にプロビジョン済みのデバイスは移行不要です。セットアップポータルには "Wi-Fi SSID 2/3" と "Wi-Fi password 2/3" が用意されています。

## PC なしで顔の向きを変える (トリプルタップ)

画面のボタンを **素早く 3 回タップ** (各タップは約 0.35 秒以内、間隔は約 0.6 秒以内) すると、「上」方向を再調整します。新しい向きは NVS に保存され電源を切っても残るので、デバイスを物理的に回した後、PC・ポータル・再書き込みなしで顔を合わせ直せます。

- **画面が傾いている / 立てて使うとき:** IMU が画面のどの辺が上かを自動判定し、4 方向のうち最も近い向きにスナップします。
- **机に平置き (画面が上):** 重力からは「上」を決められないため、トリプルタップごとに顔を +90° (時計回り) ずつ進めます (好みの向きになるまでタップを繰り返してください)。

加速度センサ軸 → パネル軸のマッピングはデバイスごとに 1 回キャリブレーションが必要です。最も簡単な方法 (再起動・ボタン操作不要) はシリアルクエリです。

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --dry-run   # (RMHCFG? を話せるクライアントなら何でも可)
# あるいは生の `RMHCFG?\n` を送ると、STATE 応答に次が含まれます:
#   "imu_enabled":true,"imu_ax":..,"imu_ay":..,"imu_az":..
```

意図する 4 つの「上向き」でデバイスを保持して `imu_ax`/`imu_ay` を読み、`src/main.cpp` の `kImuRotationOffsetDeg` / `kImuRotationSign` を調整して、スナップ角が望む `rotation` と一致するようにします。(起動ログにも `imu_enabled=...` が出力され、各トリプルタップで `imu accel x=.. y=.. z=.. inplane=..` が表示されますが、シリアル `RMHCFG?` パスのほうが簡単です。) キャリブレーション前でも、平置きの +90 ステップは手動フォールバックとして常に機能します。

ハードウェア検証済み (2026-05-19): 実機 AtomS3R 上で `imu_enabled:true` と妥当なライブ加速度を確認。マルチスロット Wi-Fi 接続と `RMHCFG` シリアルプロトコルもデバイス上で動作します。ジェスチャの *感触*、聴覚キュー、最終的なキャリブレーション定数は、引き続き実機での人手調整が必要です。

PTT (プッシュ・トゥ・トーク) の体感は従来どおりですが、押した瞬間ではなく **約 0.5 秒の長押しでアーム** されるよう変更されました。ボタンを押し続けると、録音がアームされた瞬間に短い「ピッ」というキューが鳴り、それから話します。このビープが「話してください」の合図なので、短いアーム遅延で発話の頭が切れる心配はありません。タップは PTT アーム時間より短いため、タップでマイクが開くことはなく、誤って 1 回だけタップしても Failed の顔が一瞬出ることはありません。(内部的には、共有 ES8311 コーデックをマイクに切り替える前にキュー音を完全に出し切るので、既知の録音/再生破損の危険は再発しません。)

## PC からの USB プロビジョニング (ポータルでタイプ入力しない)

AtomS3R を USB-C で PC に接続した状態で、Wi-Fi (×3)・認証トークン・サーバ URL をポータルに手入力する代わりに一発で送り込めます。

```bash
node scripts/atoms3r-provision.mjs \
  --wifi "HomeSSID:homepass" --wifi "CafeSSID:cafepass" \
  --http-base http://192.168.1.10:8765 \
  --ws-url ws://192.168.1.10:8765/ws \
  --device-id atom-headroom-1 --reboot
```

認証トークンは `--token`、無ければ環境変数 `MH_FACE_AUTH_TOKEN`、それも無ければ共有 env ファイル `${MH_SHARED_ENV_FILE:-$HOME/.config/minimum-headroom.env}` から自動解決されます。これは稼働中の operator stack と同じソースなので、stack が立っていれば追加設定なしで動きます。スクリプトに npm 依存はありません (`stty` とデバイスファイルだけを使います)。`--dry-run` は実際のペイロードを (秘密はリダクトして) 表示するだけでポートを開きません。全フラグは `--help` で確認できます。

内部的にはホストとファームウェアが USB CDC シリアル上で改行区切りの `RMHCFG` 行を交換します。`RMHCFG <json>` は設定を NVS に書き込み (任意の `"reboot":true` で再起動)、`RMHCFG?` は現在の設定をパスワード/トークンを長さのみにリダクトして返します。ファームウェアは `loop()` 中いつでも (セットアップポータル表示中も) これを受け付けます。

Wi-Fi に接続できると、ファームウェアは設定された WebSocket URL を開き、以下の minimum-headroom ペイロードをミラーリングします。

- `event`: コマンド開始、成功、失敗、permission、retry、idle の各状態に応じて表情を変更。
- `tts_state`: queued/speaking/error/idle 状態を表示。
- `tts_mouth`: ペイロードの `open` 値から口の開きを駆動。

Wi-Fi 接続中は、Atom ボタンはオフラインの表情デモではなくプッシュ・トゥ・トーク用途になります。ボタンを長押しすると、Atomic Echo Base のマイクから最大 8 秒間、16 kHz モノラル PCM を録音します。離すと、ファームウェアはそのクリップを `audio/wav` でラップして次に POST します。

```text
<Face HTTP base>/api/operator/asr?lang=<ASR language>
```

ASR が空でないテキストを返した場合、Atom は `source: "atom"`、`response_kind: "text"` の `operator_response` WebSocket ペイロードを送ります。Atom → PC の WebSocket が利用できない場合は、認証付き HTTP にフォールバックします。

```text
<Face HTTP base>/api/operator/response
```

Atomic Echo Base はマイクとスピーカーで 1 つの ES8311 コーデックを共有しているため、録音とスピーカー再生は直列化されます。

通常モードのヘルス用エンドポイントはデスクでのデバッグに便利です。

```text
http://<atom-ip>/health
```

設定された face HTTP/WS URL、ASR 言語、認証の有無、Atom 発の WebSocket が接続済みかを返します。認証トークン自体の値は返しません。

PC 側で `MH_FACE_AUTH_TOKEN` を有効にしている場合は、セットアップページにも同じトークンを設定してください。ファームウェアは同一 LAN を想定した初期実装として、これを WebSocket URL の `auth_token` クエリとして付与します。

デフォルトの表示優先エージェントは `__operator__` です。他エージェントからの TTS/状態ペイロードも受理しますが、最近のオペレータペイロードに短い優先窓を設けているため、ヘルパーの発話で物理オペレータの顔が即座に上書きされることはありません。将来の Atom 入力ペイロードはデフォルトで `__operator__` を対象とし、明示的に設定されていない限りヘルパーペインを直接ターゲットしてはいけません。

## ローカル設定

リポジトリに含まれる `include/headroom_config.example.h` は安全なプレースホルダだけを持ちます。開発専用のデフォルト値を入れたい場合は `include/headroom_config.local.h` を作成してください (git で無視されます)。実行時の設定は NVS/Preferences が存在すればそこから読み込まれ、Atom 上のセットアップポータルから Wi-Fi、サーバ URL、認証トークン、ASR 言語、向きを再書き込みせずに更新できます。
