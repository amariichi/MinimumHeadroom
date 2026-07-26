# Documentation Index

Index language: [English](#english) | [日本語](#japanese)

Project README: [README.md](../README.md) | [README.ja.md](../README.ja.md)

<a id="english"></a>

## English

This page maps the repository documentation. Read the top-level README first,
then use this index when you need setup details, architecture notes, or
subsystem-specific guides.

### Guides

- [AtomS3R Devices](guides/atom-devices.md#english) ([日本語](guides/atom-devices.md#japanese)) - Start here for hardware: the two physical Atom devices, AtomS3R vs AtomS3R-M12, which docs belong to which, and the `--asr-lang` gotcha.
- [Generic Browser Media Integration](guides/generic-browser-media.md#english) ([日本語](guides/generic-browser-media.md#japanese)) - Prepare a source-agnostic third-party MP3 producer/controller, including optional catalog and local-file safety, diagrams, HTTP/MCP contracts, iPhone/iPad behavior, security, and optional TTS focus.
- [Operator Stack and ASR Guide](guides/operator-stack.md#english) ([日本語](guides/operator-stack.md#japanese)) - Launcher choices, tmux bridge behavior, operator UI, ASR profiles, remote access, and recovery.
- [Separate Interpreter Stack Guide](guides/interpreter-stack.md#english) ([日本語](guides/interpreter-stack.md#japanese)) - Four local provider presets, measured selection guidance, setup/doctor/start/stop, deterministic language pairs, phone/Atom controls, privacy, and third-party licenses.
- [Gemma 4, GGUF, MTP, and llama.cpp](guides/gemma4-llama-cpp.md#english) ([日本語](guides/gemma4-llama-cpp.md#japanese)) - Official pinned artifacts, the already-converted assistant GGUF, llama.cpp compatibility, and reproducible conversion.
- [TTS and Speech Guide](guides/tts-and-speech.md#english) ([日本語](guides/tts-and-speech.md#japanese)) - Kokoro/Supertonic/Qwen3 setup, speech gating, long-speech behavior, and text normalization.
- [AtomS3R Voice Guide](guides/atoms3r-voice.md#english) ([日本語](guides/atoms3r-voice.md#japanese)) - The face AtomS3R: hands-free VAD, flashing/provisioning, ADPCM, tuning knobs, PTT, and troubleshooting.
- [Tailscale Travel-Router Guide](guides/tailscale-travel-router-setup.md#english) ([日本語](guides/tailscale-travel-router-setup.md#japanese)) - Subnet routing for Tailscale-incapable devices and the bidirectional ACL model.
- [Multi-Agent Guide](guides/multi-agent.md#english) ([日本語](guides/multi-agent.md#japanese)) - Helper spawning, permission presets, mission assignment, owner inbox, worktree isolation, and safety notes.
- [M12 Vision Guide](guides/m12-vision.md#english) ([日本語](guides/m12-vision.md#japanese)) - AtomS3R-M12 perception flow, memory/forgetting, corrections, watches, and spoken alerts.

### Specs And Architecture

- [System Specification](SPEC.md) - Face app, MCP server, worker, and bridge contracts. This specification is Japanese-first.
- [Multi-Agent Orchestration Spec](multi-agent-orchestration-spec.md#english) ([日本語概要](multi-agent-orchestration-spec.md#japanese)) - Durable mission, helper lifecycle, and owner inbox semantics.
- [Hook Bridge](hook-bridge/README.md#english) ([日本語](hook-bridge/README.md#japanese)) - Runtime hook setup for Claude, Codex, and Antigravity so permission waits and idle states still speak.

### Examples And Subsystems

- [Agent Config Examples And Skills](examples/) - Drop-in MCP configs, AGENTS templates, runtime rules, and reusable local skills.
- [vision-worker README](../vision-worker/README.md#english) ([日本語](../vision-worker/README.md#japanese)) - How to run the M12 vision worker, diffusiongemma/vLLM path, environment variables, and live smoke checks.
- [AtomS3R Firmware README](../firmware/atoms3r-headroom/README.md#english) ([日本語](../firmware/atoms3r-headroom/README.md#japanese)) - One firmware project that builds both devices: flashing, device configuration, and hardware-side behavior.
- [M12 Camera Firmware Spec](../firmware/atoms3r-headroom/doc/m12-camera-firmware.md) - AtomS3R-M12-specific firmware: camera pin map, audio/camera coexistence, and the `atoms3r-m12` build. Includes a Japanese overview.
- [RMH Voice-First Mode](../examples/rmh-voice-mode/README.md) - Voice-first launcher for Claude, Codex, or Antigravity, including `--with-vision`.

<a id="japanese"></a>

## 日本語

このページはリポジトリ内ドキュメントの索引です。最初にトップレベルの
[日本語 README](../README.ja.md) を読み、詳細な設定、設計メモ、サブシステム別の
説明が必要になったときにこの索引を使ってください。

### ガイド

- [AtomS3R Devices](guides/atom-devices.md#japanese) ([English](guides/atom-devices.md#english)) - 最初に読むハードウェア整理。顔 AtomS3R と AtomS3R-M12 の違い、対応する文書、`--asr-lang` の落とし穴。
- [汎用ブラウザメディア連携](guides/generic-browser-media.md#japanese) ([English](guides/generic-browser-media.md#english)) - 第三者の MP3 配信元とコントローラーを準備する方法、任意のカタログ機能、ローカルファイルを安全に扱う方法、構成図、HTTP/MCP 契約、iPhone/iPad での挙動、セキュリティ、任意の TTS フォーカス連携。
- [Operator Stack and ASR Guide](guides/operator-stack.md#japanese) ([English](guides/operator-stack.md#english)) - 起動スクリプト、tmux bridge、operator UI、ASR プロファイル、リモート利用、復旧。
- [Separate Interpreter Stack Guide](guides/interpreter-stack.md#japanese) ([English](guides/interpreter-stack.md#english)) - 四つのlocal provider preset、実測選択表、setup/doctor/start/stop、言語ペアの確定規則、スマホ/Atom操作、データ保持、第三者license。
- [Gemma 4, GGUF, MTP, and llama.cpp](guides/gemma4-llama-cpp.md#japanese) ([English](guides/gemma4-llama-cpp.md#english)) - 公式固定artifact、変換済みassistant GGUF、llama.cpp互換性、再現可能な変換。
- [TTS and Speech Guide](guides/tts-and-speech.md#japanese) ([English](guides/tts-and-speech.md#english)) - Kokoro/Supertonic/Qwen3、発話ゲート、長文発話、発話前テキスト正規化。
- [AtomS3R Voice Guide](guides/atoms3r-voice.md#japanese) ([English](guides/atoms3r-voice.md#english)) - 顔 AtomS3R の VAD、ファーム書き込み、プロビジョニング、ADPCM、調整ノブ、PTT、トラブルシュート。
- [Tailscale Travel-Router Guide](guides/tailscale-travel-router-setup.md#japanese) ([English](guides/tailscale-travel-router-setup.md#english)) - Tailscale 非対応デバイスをトラベルルーター経由で使う手順と双方向 ACL。
- [Multi-Agent Guide](guides/multi-agent.md#japanese) ([English](guides/multi-agent.md#english)) - helper の生成、権限プリセット、ミッション割当、owner inbox、worktree 分離、安全上の注意。
- [M12 Vision Guide](guides/m12-vision.md#japanese) ([English](guides/m12-vision.md#english)) - M12 の認識の流れ、記憶と忘却、訂正、キーワード監視、音声アラート。

### 仕様とアーキテクチャ

- [System Specification](SPEC.md) - face app、MCP server、worker、bridge の契約。日本語中心の仕様です。
- [Multi-Agent Orchestration Spec](multi-agent-orchestration-spec.md#japanese) ([English](multi-agent-orchestration-spec.md#english)) - durable mission、helper lifecycle、owner inbox semantics の設計仕様。日本語概要を追加しています。
- [Hook Bridge](hook-bridge/README.md#japanese) ([English](hook-bridge/README.md#english)) - Claude、Codex、Antigravity の hook を接続し、承認待ちや idle 状態を音声・face event に変換する設定。

### 例とサブシステム

- [Agent Config Examples And Skills](examples/) - MCP 設定例、AGENTS テンプレート、runtime rules、ローカル skill 雛形。
- [vision-worker README](../vision-worker/README.md#japanese) ([English](../vision-worker/README.md#english)) - M12 vision worker、diffusiongemma/vLLM 経路、環境変数、実機確認の入口。
- [AtomS3R Firmware README](../firmware/atoms3r-headroom/README.md#japanese) ([English](../firmware/atoms3r-headroom/README.md#english)) - 顔 AtomS3R と M12 の両方をビルドする共通ファームウェアプロジェクト。
- [M12 Camera Firmware Spec](../firmware/atoms3r-headroom/doc/m12-camera-firmware.md#japanese) - AtomS3R-M12 専用ファーム仕様。カメラ pin map、音声とカメラの共存、`atoms3r-m12` build。
- [RMH Voice-First Mode](../examples/rmh-voice-mode/README.md) - Claude、Codex、Antigravity を音声優先で使う launcher。`--with-vision` を含みます。
