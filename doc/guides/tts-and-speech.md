# TTS and Speech Guide

This guide collects the detailed notes for Kokoro, Supertonic, and Qwen3 speech output, speech gating, long-utterance behavior, and the text normalization rules applied before synthesis. The top-level [README](../../README.md) stays shorter on purpose; use this file when tuning or operating TTS behavior.

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Default backend

The default operator TTS path is Kokoro ONNX plus Misaki. Supertonic and Qwen3 are optional Operator profiles and are also used by the separate interpreter; neither changes the Operator default.

Kokoro model files must be placed in `assets/kokoro/`:

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

These large model files are intentionally ignored by git.

### Optional Supertonic setup

Supertonic 3 is a CPU TTS option for the Operator and the TTS used by the
interpreter's `gemma4-supertonic` and `nemotron-gemma4-supertonic` presets.
The deprecated `light-cloud` alias resolves to the latter. The Operator and
interpreter reuse one environment and asset cache. Preview or install it explicitly:

    ./scripts/setup.sh --with-supertonic
    ./scripts/setup-supertonic.sh --dry-run
    ./scripts/setup-supertonic.sh
    TTS_ENGINE=supertonic ./scripts/run-tts-worker.sh --smoke

Select it only at Operator startup or restart:

    ./scripts/run-operator-once.sh --profile supertonic
    ./scripts/run-operator-once.sh --profile supertonic-realtime
    ./scripts/restart-operator-stack-in-place.sh --profile supertonic

The dedicated environment pins `supertonic==1.3.1`; runtime uses
`TTS(auto_download=False)` and therefore never downloads at startup. The
package-compatible model revision is
`724fb5abbf5502583fb520898d45929e62f02c0b`. Defaults are voice `M1`, eight
diffusion steps, speed `1.05`, and 44.1 kHz output. `MH_SUPERTONIC_VOICE`
accepts `M1`–`M5` or `F1`–`F5`, `MH_SUPERTONIC_STEPS` accepts 5–12, and
`MH_SUPERTONIC_SPEED` accepts 0.7–2.0.
It runs through ONNX Runtime on CPU and does not reserve model VRAM.

`MH_SUPERTONIC_LANGUAGE` defaults to `auto`. An explicit `language` on
`face_say` always wins. Without one, automatic script detection selects
Japanese for kana/Han, Korean for Hangul, Arabic for Arabic script, Greek for
Greek script, Hindi for Devanagari, and Russian for Cyrillic; other text
defaults to English. Latin-script
languages such as Spanish and French are ambiguous in short status messages,
so pass `language="es"` / `language="fr"` or set
`MH_SUPERTONIC_LANGUAGE=es` / `fr` as the deployment fallback. Explicitly
unsupported languages are rejected rather than silently spoken with English.

ONNX Runtime defaults to 10 intra-op threads and one inter-op thread in this
stack. Override them with `MH_SUPERTONIC_INTRA_OP_THREADS` and
`MH_SUPERTONIC_INTER_OP_THREADS` (1–64) only after measuring the host.
Supertonic synthesis and WAV encoding intentionally run on the Python
event-loop/main thread. On this host, moving the ONNX call through
`asyncio.to_thread` could stall after synthesis; Kokoro and Qwen retain their
existing background-thread policy.

Declared languages are Arabic, Bulgarian, Croatian, Czech, Danish, Dutch,
English, Estonian, Finnish, French, German, Greek, Hindi, Hungarian,
Indonesian, Italian, Japanese, Korean, Latvian, Lithuanian, Polish,
Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish,
Ukrainian, and Vietnamese. An unsupported language is rejected instead of
falling back to an unrelated voice profile.

Interpreter pair-change notices always pass an explicit language hint for both
utterances. Coverage tests enumerate this complete 31-language set rather than
maintaining a shorter announcement-only list, and
`config/models/interpreter-speech.json` is checked against both the JavaScript
runtime gate and this Python engine.

The upstream project announced that the public repository would be archived.
This stack therefore pins the published package and compatible assets rather
than depending on future upstream changes.

### Optional Qwen3 setup

To preview and install the optional Qwen3 environment:

    ./scripts/setup-qwen3-tts.sh --dry-run
    ./scripts/setup-qwen3-tts.sh

This creates `./.venv-qwen-tts`, pins `qwen-tts==0.1.1`, `torch==2.10.0`,
and `transformers==4.57.3`, then explicitly prefetches model revision
`85e237c12c027371202489a0ec509ded67b5e4b5`. Normal runtime sets Hugging Face
offline mode and requests local files only.

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
- `MH_QWEN_TTS_GENERATION_MODE=faithful`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.0`

</details>

`face-app` also supports `MH_QWEN_TTS_BOUNDARY_SPEAKER`, which currently defaults to `Ono_Anna` and is used only for mixed-script boundary-risk utterances. The worker itself still defaults to `Serena`.

### Qwen3 speech shaping

Qwen3 does not use Kokoro’s ASCII-versus-non-ASCII language split. It reads the full utterance through one configured speaker and one configured language profile.

`faithful` is the project default for Qwen3 generation. It disables random
sampling in both the main talker and sub-talker codec stages. This makes the
same input deterministic and removes a source of intermittent extra, omitted,
or changed words. It cannot prove that a speech model will pronounce every
name correctly. Set `MH_QWEN_TTS_GENERATION_MODE=natural` to restore the pinned
upstream sampling defaults (`do_sample=true`, temperature `0.9`) when prosodic
variation matters more than repeatability. The 0.6B CustomVoice model ignores
free-form `instruct` text, so an instruction such as “read exactly” is not used
as the fidelity control.

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

For interpreter output, Qwen3 is declared for Chinese, English, Japanese,
Korean, German, French, Russian, Portuguese, Spanish, and Italian. Other
translation targets remain text-only; they are not silently mapped to English.

### Related files

- `tts-worker/src/tts_worker/qwen3_engine.py`
- `tts-worker/src/tts_worker/qwen3_text.py`
- `tts-worker/src/tts_worker/supertonic_engine.py`
- `face-app/dist/tts_controller.js`
- `config.yaml`

<a id="japanese"></a>
## 日本語

### 既定のバックエンド

operatorの既定TTSはKokoro ONNX + Misakiです。SupertonicとQwen3は任意のoperator profileであり、
独立した通訳スタックでも使いますが、operatorの既定値は変更しません。

Kokoro のモデルファイルは `assets/kokoro/` に置きます。

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

これらの大きなモデルファイルは、意図的に Git の管理対象から除外しています。

### 任意のSupertonicセットアップ

Supertonic 3はoperatorで選択できるCPU TTSで、通訳の`gemma4-supertonic`と
`nemotron-gemma4-supertonic`でも使います。非推奨の`light-cloud`は後者のaliasです。
operatorと通訳は同じ環境・asset cacheを再利用します。

    ./scripts/setup.sh --with-supertonic
    ./scripts/setup-supertonic.sh --dry-run
    ./scripts/setup-supertonic.sh
    TTS_ENGINE=supertonic ./scripts/run-tts-worker.sh --smoke

operatorでは起動時または安全なin-place再起動時だけ選択します。

    ./scripts/run-operator-once.sh --profile supertonic
    ./scripts/run-operator-once.sh --profile supertonic-realtime
    ./scripts/restart-operator-stack-in-place.sh --profile supertonic

専用環境は `supertonic==1.3.1`、package互換model revision
`724fb5abbf5502583fb520898d45929e62f02c0b` を固定します。runtimeは
`TTS(auto_download=False)` なので起動時downloadを行いません。既定値はvoice `M1`、
8 steps、speed `1.05`、44.1 kHzです。
`MH_SUPERTONIC_VOICE`は`M1`〜`M5`または`F1`〜`F5`、`MH_SUPERTONIC_STEPS`は
5〜12、`MH_SUPERTONIC_SPEED`は0.7〜2.0を受け付けます。範囲外の値を指定した場合、
ワーカーは起動時にエラーで停止します。
ONNX RuntimeによるCPU動作で、model用GPU VRAMは予約しません。

`MH_SUPERTONIC_LANGUAGE`の既定値は`auto`です。`face_say`に明示した`language`が常に優先されます。
省略時は、かな・漢字を日本語、Hangulを韓国語、Arabic scriptをアラビア語、Greek scriptを
ギリシャ語、Devanagariをヒンディー語、Cyrillicをロシア語として決定し、それ以外は英語です。
短いLatin script文だけではスペイン語・フランス語・英語などを確実に区別できないため、
`language="es"`のように明示するか、deployment既定を`MH_SUPERTONIC_LANGUAGE=es`のように
設定します。明示された非対応言語を英語へ黙ってfallbackしません。

ONNX Runtimeの既定thread数はintra-op 10、inter-op 1です。hostで測定した場合だけ
`MH_SUPERTONIC_INTRA_OP_THREADS`と`MH_SUPERTONIC_INTER_OP_THREADS`（1–64）で
変更します。SupertonicのsynthesisとWAV encodeは意図的にPython event-loop/main
threadで実行します。このhostでは`asyncio.to_thread`経由のONNX呼び出しが合成後に
停止し得たためです。Kokoro/Qwenは既存のbackground-thread policyを維持します。

明示対応はアラビア語、ブルガリア語、クロアチア語、チェコ語、デンマーク語、オランダ語、
英語、エストニア語、フィンランド語、フランス語、ドイツ語、ギリシャ語、ヒンディー語、
ハンガリー語、インドネシア語、イタリア語、日本語、韓国語、ラトビア語、リトアニア語、
ポーランド語、ポルトガル語、ルーマニア語、ロシア語、スロバキア語、スロベニア語、
スペイン語、スウェーデン語、トルコ語、ウクライナ語、ベトナム語です。非対応言語を
別言語profileへ黙ってfallbackしません。

通訳の言語pair切替案内は、二つの発話それぞれに明示的なlanguage hintを渡します。
案内専用の短いlistは作らず、この31言語全件を網羅testで列挙し、
`config/models/interpreter-speech.json`、JavaScriptのruntime gate、Python engineの
一致も検査します。

upstreamはpublic repositoryのarchive予定を告知したため、将来更新を仮定せず、公開済みの
packageと互換assetを固定して使います。

### 任意の Qwen3 セットアップ

Qwen3 の環境をpreview・導入するには、次のコマンドを実行します。

    ./scripts/setup-qwen3-tts.sh --dry-run
    ./scripts/setup-qwen3-tts.sh

このスクリプトは `./.venv-qwen-tts` を作り、`qwen-tts==0.1.1`、`torch==2.10.0`、
`transformers==4.57.3` とmodel revision
`85e237c12c027371202489a0ec509ded67b5e4b5` を固定・事前取得します。通常runtimeは
Hugging Face offline modeとlocal-only loadを使います。

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
- `MH_QWEN_TTS_GENERATION_MODE=faithful`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.0`

</details>

`face-app` 側では `MH_QWEN_TTS_BOUNDARY_SPEAKER` も使えます。現在の既定値は `Ono_Anna` で、
日本語と英語が切り替わる境界を含む、読み上げが不安定になりやすい文だけに使用します。
ワーカー自体の既定話者は `Serena` のままです。

### Qwen3 の発話調整

Qwen3 は、Kokoro のような ASCII / 非 ASCII の単純な分岐を使いません。1つの話者と1つの
言語プロファイルで、全文を読み上げます。

Qwen3生成の既定は`faithful`です。main talkerとsub-talkerのcodec生成で乱数samplingを
両方無効にし、同じ入力を決定的にします。これにより、実行ごとに語を足す、落とす、
置き換える原因の一つを除きます。ただし音声modelが全固有名詞を正しく発音することまで
保証するものではありません。抑揚の変化を再現性より優先する場合だけ
`MH_QWEN_TTS_GENERATION_MODE=natural`を指定すると、固定したupstream既定
（`do_sample=true`、temperature `0.9`）へ戻せます。0.6B CustomVoice modelは自由文の
`instruct`を無視するため、「原文どおり読む」という指示文ではなく生成policyで制御します。

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

通訳用Qwen3は中国語、英語、日本語、韓国語、ドイツ語、フランス語、ロシア語、
ポルトガル語、スペイン語、イタリア語を明示対応とします。それ以外の翻訳先はtext-onlyで、
英語などへ黙って置換しません。

### 関連ファイル

- `tts-worker/src/tts_worker/qwen3_engine.py`
- `tts-worker/src/tts_worker/qwen3_text.py`
- `tts-worker/src/tts_worker/supertonic_engine.py`
- `face-app/dist/tts_controller.js`
- `config.yaml`
