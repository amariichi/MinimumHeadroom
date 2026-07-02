# Documentation Index

[English](../README.md) | [日本語](../README.ja.md)

This page maps the repository documentation. Read the top-level README first,
then use this index when you need setup details, architecture notes, or
subsystem-specific guides.

## Guides

- [Operator Stack and ASR Guide](guides/operator-stack.md) - Launcher choices, tmux bridge behavior, operator UI, ASR profiles, remote access, and recovery. 日本語: operator stack の運用詳細。
- [TTS and Speech Guide](guides/tts-and-speech.md) - Kokoro/Qwen3 setup, speech gating, long-speech behavior, and text normalization. 日本語: 音声合成まわりの設定と調整。
- [AtomS3R Voice Guide](guides/atoms3r-voice.md) - Hands-free VAD, device flashing/provisioning, ADPCM, tuning knobs, PTT, and troubleshooting. 日本語: AtomS3R 音声入力の実機運用。
- [Tailscale Travel-Router Guide](guides/tailscale-travel-router-setup.md) - Subnet routing for Tailscale-incapable devices and the bidirectional ACL model. 日本語: Tailscale 非対応デバイスを外出先から使う手順。
- [Multi-Agent Guide](guides/multi-agent.md) - Helper spawning, permission presets, mission assignment, owner inbox, worktree isolation, and safety notes. 日本語: helper agent の標準運用。
- [M12 Vision Guide](guides/m12-vision.md) - AtomS3R-M12 perception flow, memory/forgetting, corrections, watches, and spoken alerts. 日本語: M12 vision subsystem の全体像。

## Specs And Architecture

- [System Specification](SPEC.md) - Face app, MCP server, worker, and bridge contracts; read this before changing cross-component behavior. 日本語: 主要コンポーネントの仕様。
- [Multi-Agent Orchestration Spec](multi-agent-orchestration-spec.md) - Durable mission, helper lifecycle, and owner inbox semantics. 日本語: multi-agent runtime の内部仕様。
- [Hook Bridge](hook-bridge/README.md) - Runtime hook setup for Claude, Codex, and Antigravity so permission waits and idle states still speak. 日本語: hook 経由の face_say 安全網。

## Examples And Subsystems

- [Agent Config Examples And Skills](examples/) - Drop-in MCP configs, AGENTS templates, runtime rules, and reusable local skills. 日本語: agent 設定例とスキル雛形。
- [vision-worker README](../vision-worker/README.md) - How to run the M12 vision worker, diffusiongemma/vLLM path, environment variables, and live smoke checks. 日本語: vision backend の起動と設定。
- [AtomS3R Firmware README](../firmware/atoms3r-headroom/README.md) - Firmware flashing, device configuration, and hardware-side behavior. 日本語: AtomS3R ファームウェアの入口。
- [RMH Voice-First Mode](../examples/rmh-voice-mode/README.md) - Voice-first launcher for Claude, Codex, or Antigravity, including `--with-vision`. 日本語: RMH 音声優先ランチャ。
