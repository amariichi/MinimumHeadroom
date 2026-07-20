# TTS and Speech Guide

This guide collects the detailed notes for Kokoro and Qwen3 speech output, speech gating, long-utterance behavior, and the text normalization rules applied before synthesis. The top-level [README](../../README.md) stays shorter on purpose; use this file when tuning or operating TTS behavior.

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Default backend

The default TTS path is Kokoro ONNX plus Misaki. In the current runtime, Kokoro remains the stable default and Qwen3 is the optional advanced backend.

Kokoro model files must be placed in `assets/kokoro/`:

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

These large model files are intentionally ignored by git.

### Optional Qwen3 setup

To install the optional Qwen3 environment:

    ./scripts/setup-qwen3-tts.sh

This creates `./.venv-qwen-tts` and keeps the default Kokoro path lightweight.

To smoke-test or run with Qwen3:

    TTS_ENGINE=qwen3 ./scripts/run-tts-worker.sh --smoke
    TTS_ENGINE=qwen3 ./scripts/run-face-app.sh

### Current Qwen3 defaults

Current runtime defaults:

<details>
<summary>Qwen3 environment variables</summary>

- `MH_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `MH_QWEN_TTS_SPEAKER=Serena`
- `MH_QWEN_TTS_LANGUAGE=English`
- `MH_QWEN_JA_ASCII_MODE=preserve`
- `MH_QWEN_TTS_STYLE=neutral`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.0`

</details>

`face-app` also supports `MH_QWEN_TTS_BOUNDARY_SPEAKER`, which currently defaults to `Ono_Anna` and is used only for mixed-script boundary-risk utterances. The worker itself still defaults to `Serena`.

### Qwen3 speech shaping

Qwen3 does not use Kokoro’s ASCII-versus-non-ASCII language split. It reads the full utterance through one configured speaker and one configured language profile.

Current behavior:

- if an English-profile utterance begins with a CJK ideograph, Qwen3 prepends `はい、` for audio generation only
- if an ASCII token is immediately followed by kanji, the speech-only text inserts Japanese punctuation to reduce abrupt language switching
- common speech-only aliases are applied before synthesis
  - `request` -> `リクエスト`
  - `pull request` -> `プルリクエスト`

`MH_QWEN_TTS_SPEED` now defaults to `1.0`, which keeps the raw waveform unstretched. Speeds above `1.0` can make speech faster, but they can also reduce clarity because extra time-stretch is applied.

### Speech gate

`face-app` reads `config.yaml` from repository root (or `FACE_CONFIG_PATH`) and applies `speech_gate` values to voice throttling.

The checked-in defaults are intentionally relaxed:

    speech_gate:
      min_interval_priority1_ms: 1500
      global_window_ms: 60000
      global_limit_low_priority: 24
      session_window_ms: 60000
      session_limit_low_priority: 12
      dedupe_ms_low_priority: 800

These govern rate limiting for `face.say` based on priority, global windows, session windows, and dedupe timing.

### Long speech behavior

Current long-speech rules:

- omitted `ttl_ms` defaults to `60000`
- `FACE_SAY_DEFAULT_TTL_MS` can override the default on `mcp-server`
- `face-app` also supports `tts.default_ttl_ms` in `config.yaml`
- `tts.auto_interrupt_after_ms` can promote a delayed `replace` to `interrupt`

During playback:

- `policy=replace` keeps current playback and only keeps the latest pending utterance
- `policy=interrupt` (or `priority=3`) stops current playback immediately

### Text normalization before speech

The runtime now uses separate normalization paths for English-like and Japanese-like text.

English text normalization applies when the utterance does not contain Japanese script:

- smart quotes become ASCII quotes
- ellipsis becomes a regular space
- Japanese punctuation (`。`, `、`, `・`) becomes a regular space
- no-break spaces become regular spaces
- Latin combining marks are stripped from Latin letters
- inline dashes between ASCII tokens become spaces

Japanese text normalization applies when the utterance contains Japanese script:

- smart quotes become ASCII quotes
- ellipsis becomes `、`
- no-break spaces become regular spaces
- Latin combining marks are stripped from Latin letters
- Japanese punctuation is preserved
- a single decimal separator inside a Japanese numeric chain becomes `点`
  - `4.8度` -> `4点8度`
  - `一・八度` -> `一点八度`
- version-like strings with multiple separators are left untouched
  - `1.2.3` stays `1.2.3`

### Kokoro-only language routing

Only Kokoro uses the simple language split:

- ASCII-only text -> English voice (`en-us`, speed `1.0`)
- text containing non-ASCII -> Japanese voice (`j`, speed `1.2`)

Qwen3 does not use this split.

### Related files

- `tts-worker/src/tts_worker/qwen3_engine.py`
- `tts-worker/src/tts_worker/qwen3_text.py`
- `face-app/dist/tts_controller.js`
- `config.yaml`

<a id="japanese"></a>
## 日本語

### 既定のバックエンド

既定の TTS は Kokoro ONNX + Misaki です。現在は Kokoro が安定した標準経路で、Qwen3 は
上級者向けの任意のバックエンドです。

Kokoro のモデルファイルは `assets/kokoro/` に置きます。

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

これらの大きなモデルファイルは、意図的に Git の管理対象から除外しています。

### 任意の Qwen3 セットアップ

Qwen3 の環境を導入するには、次のコマンドを実行します。

    ./scripts/setup-qwen3-tts.sh

このスクリプトは `./.venv-qwen-tts` を作り、既定の Kokoro 経路を軽いまま保ちます。

Qwen3 の動作確認と起動には、次のコマンドを使います。

    TTS_ENGINE=qwen3 ./scripts/run-tts-worker.sh --smoke
    TTS_ENGINE=qwen3 ./scripts/run-face-app.sh

### 現在の Qwen3 既定値

現在の既定値は次のとおりです。

<details>
<summary>Qwen3 環境変数</summary>

- `MH_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `MH_QWEN_TTS_SPEAKER=Serena`
- `MH_QWEN_TTS_LANGUAGE=English`
- `MH_QWEN_JA_ASCII_MODE=preserve`
- `MH_QWEN_TTS_STYLE=neutral`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.0`

</details>

`face-app` 側では `MH_QWEN_TTS_BOUNDARY_SPEAKER` も使えます。現在の既定値は `Ono_Anna` で、
日本語と英語が切り替わる境界を含む、読み上げが不安定になりやすい文だけに使用します。
ワーカー自体の既定話者は `Serena` のままです。

### Qwen3 の発話調整

Qwen3 は、Kokoro のような ASCII / 非 ASCII の単純な分岐を使いません。1つの話者と1つの
言語プロファイルで、全文を読み上げます。

現在の動作は次のとおりです。

- English プロファイルで文頭が CJK 漢字の場合は、音声生成時だけ `はい、` を前置きします。
- ASCII トークンの直後に漢字が続く場合は、読み上げ用テキストへ日本語の句読点を補い、
  言語の切り替わりを滑らかにします。
- 合成前に、読み上げだけに使う別名を適用します。
  - `request` -> `リクエスト`
  - `pull request` -> `プルリクエスト`

`MH_QWEN_TTS_SPEED` の現在の既定値は `1.0` です。生成した波形をそのまま使う設定です。
`1.0` より大きくすると読み上げは速くなりますが、時間方向の伸縮によって明瞭さが少し
低下することがあります。

### 発話ゲート

`face-app` はリポジトリルートの `config.yaml`（または `FACE_CONFIG_PATH`）を読み、`speech_gate` を使って発話頻度を制御します。

リポジトリに含まれる既定値:

    speech_gate:
      min_interval_priority1_ms: 1500
      global_window_ms: 60000
      global_limit_low_priority: 24
      session_window_ms: 60000
      session_limit_low_priority: 12
      dedupe_ms_low_priority: 800

これらの値は、`face.say` の優先度、全体の時間枠、セッション単位の時間枠、重複を抑制する
時間に適用されます。

### 長文発話の挙動

長文に関する現在の規則:

- `ttl_ms` 未指定時の既定は `60000`
- `mcp-server` 側では `FACE_SAY_DEFAULT_TTL_MS` で上書き可能
- `face-app` 側では `config.yaml` の `tts.default_ttl_ms` に対応
- `tts.auto_interrupt_after_ms` で、遅れて来た `replace` を `interrupt` 扱いに昇格できる

発話中は、次のように処理します。

- `policy=replace`: 現在の再生を続け、保留する発話は最新の1件だけにします。
- `policy=interrupt`（または `priority=3`）: 現在の再生を直ちに停止します。

### 発話前のテキスト正規化

現在は、英語寄りの文と日本語寄りの文で正規化経路を分けています。

英語テキストの正規化（日本語の文字を含まない文）:

- スマートクォートを ASCII クォートへ
- 三点リーダや `...` を半角スペースへ
- `。` `、` `・` を半角スペースへ
- 改行されない空白（no-break space）を半角スペースへ
- ラテン文字に付いた結合文字を削る
- ASCII トークン間のダッシュを空白へ

日本語テキストの正規化（日本語の文字を含む文）:

- スマートクォートを ASCII クォートへ
- 三点リーダや `...` を `、` へ
- 改行されない空白（no-break space）を半角スペースへ
- ラテン文字に付いた結合文字を削る
- 日本語の句読点は保持
- 日本語の数値列の中の単発小数区切りを `点` に変換
  - `4.8度` -> `4点8度`
  - `一・八度` -> `一点八度`
- 区切りが複数ある版番号のような文字列はそのまま
  - `1.2.3` は `1.2.3`

### Kokoro のみの言語ルーティング

単純な言語分岐を使うのは Kokoro だけです。

- ASCII のみ → 英語音声（`en-us`、速度 `1.0`）
- 非 ASCII を含む → 日本語音声（`j`、速度 `1.2`）

Qwen3 はこの分岐を使いません。

### 関連ファイル

- `tts-worker/src/tts_worker/qwen3_engine.py`
- `tts-worker/src/tts_worker/qwen3_text.py`
- `face-app/dist/tts_controller.js`
- `config.yaml`
