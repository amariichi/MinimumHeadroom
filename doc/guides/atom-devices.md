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
[`MH_LANG`](../../README.md#en-language-mh-lang)), re-provision
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

このプロジェクトでは、最大 **2台**の M5Stack Atom 実機を使えます。名前がほぼ同じため、
1台のデバイスだと誤解しやすい点に注意してください。このページは、それぞれの役割と違い、
参照すべきドキュメントを示す案内図です。

### 2つのデバイス（要点）

- **AtomS3R** — *顔＋音声入出力。* 128×128 の LCD に表示する顔、Atomic Echo Base による
  発話、PTT／ハンズフリー音声入力用のマイクを備えます。対話に使う卓上端末で、
  **オペレータースタック**に属します。
- **AtomS3R-M12** — *カメラ＋音声出力。* カメラと、音声アラート用の Atomic Echo Base を
  備えます。**マイクは搭載しておらず**、見ることと話すことに特化しています。
  **視覚スタック**に属します。

どちらも「AtomS3R」基板なので名前が衝突します。ドキュメント中では、無印の
**AtomS3R** は顔デバイス、**AtomS3R-M12** はカメラデバイスを指します。

| | **AtomS3R**（顔＋音声入出力） | **AtomS3R-M12**（カメラ＋音声出力） |
| --- | --- | --- |
| 役割 | 話しかける卓上の顔 | シーンを説明するアンビエントカメラ |
| マイク（音声入力） | **あり** — PTT + ハンズフリー VAD | **なし** — ファームウェアで無効 |
| スピーカ（音声出力） | Atomic Echo Base | Atomic Echo Base |
| 画面 | 128×128 LCD 顔 | なし（`-DHEADROOM_NO_DISPLAY`） |
| カメラ | なし | あり |
| 接続先 | オペレータースタック（face-app、ASR、TTS） | 視覚スタック（vision-worker、diffusiongemma） |
| ファームウェアのビルド環境 | `m5stack-atoms3r` | `atoms3r-m12` |
| ファームウェアのエントリーポイント | `src/main.cpp` | `src/main_m12.cpp` |
| `--asr-lang` プロビジョン | **有効**（音声を取り込むため） | **無視**（マイク無し） |

どちらのデバイスも必須ではありません。中心となる顔と音声の機能は、専用ハードウェアが
なくてもブラウザだけで動きます。各デバイスが追加する機能は、
[ハードウェア段階](../../README.ja.md#ハードウェア段階tiers)を参照してください。

### 1つのファームプロジェクト・2つのビルドターゲット

両デバイスが1つのファームフォルダ `firmware/atoms3r-headroom/` に同居しているのは
意図的です。Wi-Fi 通信、設定、シリアルプロビジョニング、セットアップポータル、音声経路など、
ソースの大半を共有しているためです。ビルドは2つの PlatformIO 環境に分けています。

- `env:m5stack-atoms3r` は `src/main.cpp` をビルドし、**顔デバイス**を生成します。
- `env:atoms3r-m12` は顔デバイス用の環境を継承し、`main.cpp` と LCD レンダラーを除外します。
  `-DHEADROOM_M12 -DHEADROOM_NO_DISPLAY` を追加して `src/main_m12.cpp` をビルドし、
  **カメラデバイス**を生成します。

このように、1つのフォルダーから2種類のファームウェアを生成できます。各デバイスに対応する
環境を選んで書き込んでください。詳しくは
[firmware README](../../firmware/atoms3r-headroom/README.md)を参照してください。

### プロビジョニングと `--asr-lang` の注意点

プロビジョニングでは、Wi-Fi、face-app の URL、認証トークン、デバイス ID、ASR の言語を、
USB シリアル経由で**1台ずつ**書き込みます。

```bash
node scripts/atoms3r-provision.mjs --port /dev/ttyACM0 --device-id atom-... [options]
```

`--asr-lang ja|en` は**デバイスが取り込む音声**の言語を設定します。**AtomS3R-M12 は
マイクを持たない**ため、このオプションは**顔 AtomS3R でのみ**意味を持ちます。`--asr-lang`
は顔デバイスにだけ設定してください（M12 に設定しても効果はありません）。既定の運用言語を
変えたときは、顔デバイスを一度だけ再プロビジョニングします。詳しくは
[`MH_LANG`](../../README.ja.md#ja-language-mh-lang)を参照してください。

### デバイス別の読む順序

ドキュメントは、ファームウェア、ワーカー、ガイドなどのサブシステム別に分かれています。
各デバイスについては、次の順に読んでください。

**AtomS3R（顔＋音声入出力）:**
1. [Firmware README](../../firmware/atoms3r-headroom/README.md) — ビルド、書き込み、セットアップポータル、USB プロビジョニング（`m5stack-atoms3r` 環境）。
2. [AtomS3R Voice Guide](atoms3r-voice.md#japanese) — ハンズフリー VAD、PTT、調整項目、トラブルシューティング。
3. [Operator Stack and ASR Guide](operator-stack.md#japanese) — 顔デバイスが接続するスタック。
4. [RMH Voice-First Mode](../../examples/rmh-voice-mode/README.md) — 顔デバイスを通じてコーディングエージェントと会話する方法。

**AtomS3R-M12（カメラ＋音声出力）:**
1. [M12 Camera Firmware Spec](../../firmware/atoms3r-headroom/doc/m12-camera-firmware.md) — カメラのピン配置、音声とカメラの共存、`atoms3r-m12` 環境。
2. [vision-worker README](../../vision-worker/README.md) — vision-worker と diffusiongemma の起動、環境変数。
3. [M12 Vision Guide](m12-vision.md#japanese) — 知覚、記憶、忘却、修正、アラートを含む情報のライフサイクル。
4. [atoms3r-vision skill](../../doc/examples/skills/atoms3r-vision/SKILL.md) — エージェントがカメラメモリを問い合わせる方法。
