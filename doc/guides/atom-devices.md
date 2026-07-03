# AtomS3R Devices: Face and Camera

[English](#english) | [日本語](#japanese)

This project can use up to **two** physical M5Stack Atom devices. Their names
are almost identical, so it is easy to assume there is only one. This page is
the map: what each device is, how they differ, and where each one's
documentation lives.

<a id="english"></a>

## English

### The two devices at a glance

- **AtomS3R** — *face + voice I/O.* A 128×128 LCD face plus an Atomic Echo Base
  for speech, and a microphone for push-to-talk / hands-free voice input. This
  is the desk companion you talk to; it belongs to the **operator stack**.
- **AtomS3R-M12** — *camera + voice output.* A camera plus an Atomic Echo Base
  for spoken alerts. It has **no microphone** — it only sees and speaks. It
  belongs to the **vision stack**.

They are both "AtomS3R" boards, which is why the names collide. Throughout the
docs, the plain name **AtomS3R** means the face device and **AtomS3R-M12** means
the camera device.

| | **AtomS3R** (face + voice I/O) | **AtomS3R-M12** (camera + voice output) |
| --- | --- | --- |
| Role | Desk face you talk to | Ambient camera that narrates the scene |
| Microphone (voice input) | **Yes** — PTT + hands-free VAD | **No** — mic is disabled in firmware |
| Speaker (voice output) | Atomic Echo Base | Atomic Echo Base |
| Display | 128×128 LCD face | None (`-DHEADROOM_NO_DISPLAY`) |
| Camera | No | Yes |
| Talks to | Operator stack (face-app, ASR, TTS) | Vision stack (vision-worker, diffusiongemma) |
| Firmware build env | `m5stack-atoms3r` | `atoms3r-m12` |
| Firmware entry point | `src/main.cpp` | `src/main_m12.cpp` |
| `--asr-lang` provisioning | **Applies** (it captures your voice) | **Ignored** (no microphone) |

Neither device is required to use minimum-headroom — the core face + voice
experience runs in a browser with no hardware at all. See the
[hardware tiers](../../README.md#hardware-tiers) for what each device adds.

### One firmware project, two build targets

Do not be surprised that both devices live in a single firmware folder,
`firmware/atoms3r-headroom/`. That is deliberate: they share almost all of their
source (Wi-Fi transport, settings, serial provisioning, setup portal, and the
audio path). The build is split into two PlatformIO environments:

- `env:m5stack-atoms3r` builds `src/main.cpp` → the **face** device.
- `env:atoms3r-m12` extends the face env, drops `main.cpp` and the LCD renderer,
  adds `-DHEADROOM_M12 -DHEADROOM_NO_DISPLAY`, and builds `src/main_m12.cpp` →
  the **camera** device.

So one folder produces two firmwares. Flash each device with its own env; see
the [firmware README](../../firmware/atoms3r-headroom/README.md).

### Provisioning, and the `--asr-lang` gotcha

Provisioning writes Wi-Fi, face-app URLs, auth token, device id, and ASR
language onto a device over USB serial, one device at a time:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --device-id atom-... [options]
```

`--asr-lang ja|en` sets the language of **voice the device captures**. Because
the **AtomS3R-M12 has no microphone**, this option only matters for the **face
AtomS3R**. Provision `--asr-lang` on the face device only; setting it on the
M12 has no effect. When you change the deployment language (see
[`MH_LANG`](../../README.md#language-japanese--english-mh_lang)), re-provision
the face device once.

### Where each device's docs live (reading paths)

The documentation is organized by subsystem (firmware, workers, guides), so each
device's story is spread across several files. Read them in this order:

**AtomS3R (face + voice I/O):**
1. [Firmware README](../../firmware/atoms3r-headroom/README.md) — build, flash, setup portal, USB provisioning (`m5stack-atoms3r` env).
2. [AtomS3R Voice Guide](atoms3r-voice.md#english) — hands-free VAD, PTT, tuning knobs, troubleshooting.
3. [Operator Stack and ASR Guide](operator-stack.md#english) — the stack the face device connects to.
4. [RMH Voice-First Mode](../../examples/rmh-voice-mode/README.md) — talk to a coding agent through the face device.

**AtomS3R-M12 (camera + voice output):**
1. [M12 Camera Firmware Spec](../../firmware/atoms3r-headroom/doc/m12-camera-firmware.md) — camera pin map, audio/camera coexistence, `atoms3r-m12` env.
2. [vision-worker README](../../vision-worker/README.md) — run the vision worker + diffusiongemma; environment variables.
3. [M12 Vision Guide](m12-vision.md#english) — the information lifecycle: perception, memory, forgetting, corrections, alerts.
4. [atoms3r-vision skill](../../doc/examples/skills/atoms3r-vision/SKILL.md) — how an agent queries the camera memory.

<a id="japanese"></a>

## 日本語

### 2つのデバイス（要点）

- **AtomS3R** — *顔＋音声入出力。* 128×128 の LCD 顔と Atomic Echo Base による発話、
  そして PTT／ハンズフリー音声入力用のマイクを備えます。話しかける相手の卓上端末で、
  **operator stack** に属します。
- **AtomS3R-M12** — *カメラ＋音声出力。* カメラと、音声アラート用の Atomic Echo Base を
  備えます。**マイクは非搭載** — 見る／喋る専用です。**vision stack** に属します。

どちらも「AtomS3R」基板なので名前が衝突します。ドキュメント中では、無印の
**AtomS3R** は顔デバイス、**AtomS3R-M12** はカメラデバイスを指します。

| | **AtomS3R**（顔＋音声入出力） | **AtomS3R-M12**（カメラ＋音声出力） |
| --- | --- | --- |
| 役割 | 話しかける卓上の顔 | シーンを説明するアンビエントカメラ |
| マイク（音声入力） | **あり** — PTT + ハンズフリー VAD | **なし** — firmware でマイク無効 |
| スピーカ（音声出力） | Atomic Echo Base | Atomic Echo Base |
| 画面 | 128×128 LCD 顔 | なし（`-DHEADROOM_NO_DISPLAY`） |
| カメラ | なし | あり |
| 接続先 | operator stack（face-app, ASR, TTS） | vision stack（vision-worker, diffusiongemma） |
| ファーム build env | `m5stack-atoms3r` | `atoms3r-m12` |
| ファーム エントリ | `src/main.cpp` | `src/main_m12.cpp` |
| `--asr-lang` プロビジョン | **有効**（音声を取り込むため） | **無視**（マイク無し） |

どちらのデバイスも必須ではありません — コアの顔＋音声体験はハード無しのブラウザだけで
動きます。各デバイスが何を足すかは[ハードウェア段階](../../README.ja.md#ハードウェア段階tiers)を参照。

### 1つのファームプロジェクト・2つのビルドターゲット

両デバイスが1つのファームフォルダ `firmware/atoms3r-headroom/` に同居しているのは
意図的です。ソースの大半（Wi-Fi transport・設定・シリアルプロビジョン・セットアップ
ポータル・音声パス）を共有しているためで、ビルドを2つの PlatformIO 環境に分けています:

- `env:m5stack-atoms3r` は `src/main.cpp` をビルド → **顔**デバイス。
- `env:atoms3r-m12` は顔 env を継承し、`main.cpp` と LCD レンダラを除外、
  `-DHEADROOM_M12 -DHEADROOM_NO_DISPLAY` を追加して `src/main_m12.cpp` をビルド →
  **カメラ**デバイス。

つまり1フォルダから2つのファームができます。各デバイスは自分の env で焼いてください。
[firmware README](../../firmware/atoms3r-headroom/README.md) を参照。

### プロビジョンと `--asr-lang` の落とし穴

プロビジョンは Wi-Fi・face-app URL・認証トークン・device id・ASR 言語を、USB シリアル
経由で**1台ずつ**デバイスに書き込みます:

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --device-id atom-... [options]
```

`--asr-lang ja|en` は**デバイスが取り込む音声**の言語を設定します。**AtomS3R-M12 は
マイクを持たない**ため、このオプションは**顔 AtomS3R でのみ**意味を持ちます。`--asr-lang`
は顔デバイスにだけプロビジョンしてください（M12 に設定しても効果はありません）。
デプロイ言語を変えたとき（[`MH_LANG`](../../README.ja.md#言語-日本語--英語-mh_lang) 参照）は、
顔デバイスを一度だけ再プロビジョンします。

### 各デバイスのドキュメントの所在（読む順）

ドキュメントはサブシステム別（firmware・worker・ガイド）に並んでいるため、各デバイスの
話は複数ファイルに分かれています。次の順で読んでください:

**AtomS3R（顔＋音声入出力）:**
1. [Firmware README](../../firmware/atoms3r-headroom/README.md) — ビルド・焼き・セットアップポータル・USB プロビジョン（`m5stack-atoms3r` env）。
2. [AtomS3R Voice Guide](atoms3r-voice.md#japanese) — ハンズフリー VAD・PTT・調整ノブ・トラブルシュート。
3. [Operator Stack and ASR Guide](operator-stack.md#japanese) — 顔デバイスが接続するスタック。
4. [RMH Voice-First Mode](../../examples/rmh-voice-mode/README.md) — 顔デバイス越しにコーディングエージェントと会話。

**AtomS3R-M12（カメラ＋音声出力）:**
1. [M12 Camera Firmware Spec](../../firmware/atoms3r-headroom/doc/m12-camera-firmware.md) — カメラピンマップ・音声とカメラの共存・`atoms3r-m12` env。
2. [vision-worker README](../../vision-worker/README.md) — vision worker + diffusiongemma の起動・環境変数。
3. [M12 Vision Guide](m12-vision.md#japanese) — 情報のライフサイクル: 知覚・メモリ・忘却・修正・アラート。
4. [atoms3r-vision skill](../../doc/examples/skills/atoms3r-vision/SKILL.md) — エージェントがカメラメモリを問い合わせる方法。
