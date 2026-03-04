# Operator Stack and ASR Guide

This guide collects the detailed runtime notes for the operator panel, `operator-bridge`, browser PTT, batch ASR, optional realtime ASR, and remote/mobile operation. The top-level [README](../../README.md) stays shorter on purpose; use this file when you are operating the mobile stack itself.

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Which launcher to use

Use `./scripts/run-face-app.sh` when you only want the face UI and local/browser speech output. This path now starts `face-app` with `FACE_OPERATOR_PANEL_ENABLED=0` by default, so the browser shows the simple face-oriented UI and hides the operator panel unless you explicitly override it.

Use `./scripts/run-operator-once.sh --profile qwen3-realtime` when you want the full two-pane workflow. This is the current recommended path for real mobile operation because it resolves the real agent tmux pane automatically and passes both `MH_BRIDGE_TMUX_PANE` and `MH_BRIDGE_RECOVERY_TMUX_PANE` into the stack.

Use `./scripts/run-operator-stack.sh` directly only when you intentionally want to manage tmux pane targeting and startup wiring yourself.

### Quick start

Minimal face-only path:

    ./scripts/setup.sh
    ./scripts/run-face-app.sh

Recommended full operator path:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

If you only want a shell in the agent pane first:

    ./scripts/run-operator-once.sh --profile qwen3-realtime --agent-shell

Advanced debug override, if you intentionally want the mobile mirror to follow the stack pane instead of the agent pane:

    ./scripts/run-operator-once.sh --bridge-target stack

### Audio target and UI mode

All launchers accept the same `FACE_AUDIO_TARGET` values:

- `local`: play on the host speaker only
- `browser`: send audio to connected browser clients only
- `both`: play on both

All launchers also accept the same `FACE_UI_MODE` values:

- `pc`: desktop-oriented layout with debug panels visible
- `mobile`: mobile-focused operator overlay

`run-face-app.sh` defaults to `FACE_OPERATOR_PANEL_ENABLED=0`. `run-operator-stack.sh` forces `FACE_OPERATOR_PANEL_ENABLED=1`.

### Full operator stack internals

`run-operator-once.sh` creates or reuses a tmux session, splits a window into two panes, launches your coding agent in pane 0, launches the integrated stack in pane 1, and wires the bridge target to pane 0 by default.

`run-operator-stack.sh` starts:

- `face-app`
- `operator-bridge`
- batch `asr-worker` (unless you disable it)
- optional realtime ASR (`run-vllm-voxtral.sh`) when enabled

`run-operator-bridge.sh` mirrors exactly one tmux pane and sends approved input back into that pane with `tmux send-keys`.

### tmux pane targeting

Important bridge variables:

<details>
<summary>Bridge environment variables</summary>

- `MH_BRIDGE_TMUX_PANE`: the pane that receives operator input and is mirrored back to the UI
- `MH_BRIDGE_RECOVERY_TMUX_PANE`: the safe default pane used by hidden recovery
- `MH_BRIDGE_RESTART_COMMAND`: restart command used by the `Restart` button or recovery flows
- `MH_BRIDGE_RESTART_PRE_KEYS`: keys sent before the restart command
- `MH_BRIDGE_MIRROR_LINES`: terminal tail size
- `MH_BRIDGE_MIRROR_INTERVAL_MS`: mirror publish interval

</details>

If you launch `run-operator-stack.sh` inside tmux, `TMUX_PANE` can be used automatically. If you use `run-operator-once.sh`, let it manage these variables for you.

### ASR modes

There are two ASR paths.

Batch ASR:

- browser records with `MediaRecorder`
- browser posts to `POST /api/operator/asr?lang=ja|en`
- `face-app` forwards to `asr-worker`
- `asr-worker` uses Parakeet for JA/EN batch transcription

Optional realtime ASR:

- browser streams PCM16 chunks over the existing websocket
- `face-app` relays them to a Voxtral vLLM realtime websocket
- incremental text appears while you are still speaking
- batch fallback can still run when realtime output is clearly bad or empty

The key batch ASR variables are:

<details>
<summary>Batch ASR environment variables</summary>

- `MH_OPERATOR_ASR_BASE_URL`
- `MH_OPERATOR_ASR_ENDPOINT_URL`
- `MH_OPERATOR_ASR_TIMEOUT_MS`
- `MH_OPERATOR_ASR_MODEL_JA`
- `MH_OPERATOR_ASR_MODEL_EN`

</details>

The key realtime ASR variables are:

<details>
<summary>Realtime ASR environment variables</summary>

- `MH_OPERATOR_REALTIME_ASR_ENABLED=1`
- `MH_OPERATOR_REALTIME_ASR_WS_URL`
- `MH_OPERATOR_REALTIME_ASR_MODEL`
- `MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ`
- `MH_STACK_START_REALTIME_ASR=1`
- `REALTIME_ASR_GPU_MEMORY_UTILIZATION`
- `MH_STACK_SKIP_ASR=1`

</details>

### Recommended startup modes

Parakeet only (lowest VRAM, no realtime):

    npm run setup
    MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral realtime plus Parakeet fallback (best current experience, higher VRAM):

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral realtime only (less VRAM than hybrid, no local batch fallback):

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_STACK_SKIP_ASR=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

If you already started `./scripts/run-vllm-voxtral.sh` elsewhere, point the stack at it instead of starting a second copy:

    MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

### Operator UI behavior

The operator panel is available only when `FACE_OPERATOR_PANEL_ENABLED=1`.

In the full operator stack:

- `Esc` is always visible
- `Restart` appears only for recovery or offline states
- `↑`, `Select`, and `↓` are always shown
- desktop browsers show a small `?` button near `Esc` for the keyboard cheat sheet
- terminal mirror is read-only

`PTT JA` and `PTT EN` insert recognized text at the current caret position in the text fallback input, not only at the end of the draft.

### Keyboard shortcuts

Desktop keyboard shortcuts currently mirror the UI:

- `Space`: `PTT JA`
- `Shift+Space`: `PTT EN`
- `Ctrl`: alternate `PTT JA`
- `Alt`: alternate `PTT EN`
- `Ctrl+Shift`: focus the text fallback input
- `Backspace`: `Clear` (when focus is not in an editable field)
- `Enter`: `Select`
- `Shift+Enter`: `Send Text`
- `ArrowUp` / `ArrowDown`: move the current choice
- `PageUp` / `PageDown`: scroll the terminal mirror

### Hidden mobile recovery

On mobile, tapping `Esc` four times quickly triggers hidden recovery. The fourth tap does not send a normal Escape key. Instead, the browser calls `POST /api/operator/recover-default`, and `operator-bridge` switches the mirrored and controlled pane back to `MH_BRIDGE_RECOVERY_TMUX_PANE`.

This is specifically meant to recover from the situation where the mobile UI is mirroring the wrong tmux pane and you only have the phone available.

### Remote operation over Tailscale

The safest remote path is:

    ./scripts/run-operator-once.sh --profile qwen3-realtime --no-attach
    tailscale serve --bg 8765

Then open the served URL from the phone or tablet.

### Troubleshooting

No PTT transcript:

- check `curl -sS http://127.0.0.1:8091/health`
- inspect `run-operator-stack.sh` logs for timeout or upstream configuration errors

Realtime ASR not connecting:

- check `curl -sS http://127.0.0.1:8090/v1/models`
- confirm `MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime`
- lower `REALTIME_ASR_GPU_MEMORY_UTILIZATION` if free VRAM is low

Wrong pane is mirrored on mobile:

- tap `Esc` four times quickly to trigger hidden recovery
- if you launched with `run-operator-once.sh`, this should return to the agent pane

### Related files

- `scripts/run-face-app.sh`
- `scripts/run-operator-once.sh`
- `scripts/run-operator-stack.sh`
- `face-app/dist/index.js`
- `face-app/dist/operator_bridge.js`
- `face-app/public/app.js`
- `face-app/public/operator_keyboard_ptt.js`

<a id="japanese"></a>
## 日本語

### どの起動スクリプトを使うか

`./scripts/run-face-app.sh` は、フェイス UI と音声出力だけを使いたいときに使います。この経路では `FACE_OPERATOR_PANEL_ENABLED=0` が既定なので、operator panel は明示的に有効化しない限り表示されません。

`./scripts/run-operator-once.sh --profile qwen3-realtime` は、現在の推奨フル構成です。tmux の実際のエージェントペインを自動で解決し、`MH_BRIDGE_TMUX_PANE` と `MH_BRIDGE_RECOVERY_TMUX_PANE` の両方を安全に設定します。

`./scripts/run-operator-stack.sh` の直接起動は、tmux ペインの接続先や起動構成を自分で明示的に管理したいとき向けです。

### クイックスタート

最小の face 単体:

    ./scripts/setup.sh
    ./scripts/run-face-app.sh

推奨フル構成:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

まずエージェント側をシェルだけで開く:

    ./scripts/run-operator-once.sh --profile qwen3-realtime --agent-shell

意図的に stack ペインをミラーしたいデバッグ用途:

    ./scripts/run-operator-once.sh --bridge-target stack

### 音声出力先と UI モード

`FACE_AUDIO_TARGET`:

- `local`: ホストスピーカーのみ
- `browser`: ブラウザクライアントのみ
- `both`: 両方

`FACE_UI_MODE`:

- `pc`: デスクトップ向け
- `mobile`: モバイル向けオーバーレイ

`run-face-app.sh` は `FACE_OPERATOR_PANEL_ENABLED=0` が既定、`run-operator-stack.sh` は `FACE_OPERATOR_PANEL_ENABLED=1` を強制します。

### フル operator stack の中身

`run-operator-once.sh` は tmux セッションを作成または再利用し、ウィンドウを 2 ペインに分け、0 番にエージェント、1 番に統合スタックを起動し、bridge の接続先を既定で 0 番へ向けます。

`run-operator-stack.sh` が起動するもの:

- `face-app`
- `operator-bridge`
- batch `asr-worker`（無効化しない限り）
- 任意の realtime ASR（有効時）

`run-operator-bridge.sh` は 1 つの tmux ペインだけをミラーし、承認済みの入力を `tmux send-keys` でそのペインへ送ります。

### tmux ペインの接続先

重要な bridge 変数:

<details>
<summary>Bridge 環境変数</summary>

- `MH_BRIDGE_TMUX_PANE`: ミラー対象かつ入力送信先
- `MH_BRIDGE_RECOVERY_TMUX_PANE`: 隠し復旧時の安全な既定復旧先
- `MH_BRIDGE_RESTART_COMMAND`: `Restart` ボタンなどで使う再開コマンド
- `MH_BRIDGE_RESTART_PRE_KEYS`: 再開コマンド前に送るキー
- `MH_BRIDGE_MIRROR_LINES`: terminal tail 行数
- `MH_BRIDGE_MIRROR_INTERVAL_MS`: ミラー発行間隔

</details>

`run-operator-once.sh` を使うと、これらのうち重要な接続先は自動で安全に埋まります。

### ASR モード

ASR は 2 系統あります。

batch ASR:

- ブラウザが `MediaRecorder` で録音
- `POST /api/operator/asr?lang=ja|en`
- `face-app` から `asr-worker` へ転送
- `asr-worker` が Parakeet で変換

任意の realtime ASR:

- ブラウザが PCM16 チャンクを websocket で送る
- `face-app` が Voxtral の vLLM realtime websocket へ中継
- 話している途中から増分テキストを表示
- 空振りや明らかな誤認識時は batch 側へ再確認できる

主な batch ASR 変数:

<details>
<summary>batch ASR 環境変数</summary>

- `MH_OPERATOR_ASR_BASE_URL`
- `MH_OPERATOR_ASR_ENDPOINT_URL`
- `MH_OPERATOR_ASR_TIMEOUT_MS`
- `MH_OPERATOR_ASR_MODEL_JA`
- `MH_OPERATOR_ASR_MODEL_EN`

</details>

主な realtime ASR 変数:

<details>
<summary>realtime ASR 環境変数</summary>

- `MH_OPERATOR_REALTIME_ASR_ENABLED=1`
- `MH_OPERATOR_REALTIME_ASR_WS_URL`
- `MH_OPERATOR_REALTIME_ASR_MODEL`
- `MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ`
- `MH_STACK_START_REALTIME_ASR=1`
- `REALTIME_ASR_GPU_MEMORY_UTILIZATION`
- `MH_STACK_SKIP_ASR=1`

</details>

### 推奨起動モード

Parakeet のみ（最小 VRAM、realtime なし）:

    npm run setup
    MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral realtime + Parakeet fallback（現在の本命、VRAM 多め）:

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral realtime のみ（ハイブリッドより省 VRAM）:

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_STACK_SKIP_ASR=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

すでに別ターミナルで `./scripts/run-vllm-voxtral.sh` を起動している場合:

    MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

### Operator UI の挙動

operator panel は `FACE_OPERATOR_PANEL_ENABLED=1` のときだけ表示されます。

フル operator stack では:

- `Esc` は常時表示
- `Restart` は復旧時またはオフライン時のみ
- `↑`, `Select`, `↓` は常時表示
- デスクトップでは `Esc` の近くに `?` ボタンを表示
- terminal mirror は読み取り専用

`PTT JA` / `PTT EN` の文字起こしは、テキスト入力欄の末尾固定ではなく、現在のカーソル位置へ入ります。

### キーボードショートカット

- `Space`: `PTT JA`
- `Shift+Space`: `PTT EN`
- `Ctrl`: `PTT JA` の代替
- `Alt`: `PTT EN` の代替
- `Ctrl+Shift`: テキスト入力欄へフォーカス
- `Backspace`: `Clear`（編集中でない時）
- `Enter`: `Select`
- `Shift+Enter`: `Send Text`
- `ArrowUp` / `ArrowDown`: 選択肢移動
- `PageUp` / `PageDown`: terminal mirror スクロール

### 隠し復旧（モバイル）

モバイルで `Esc` を短時間に 4 回連打すると、4 回目は通常の Escape 送信ではなく、`POST /api/operator/recover-default` を呼ぶ隠し復旧になります。`operator-bridge` はその要求を受けて、ミラー対象と入力送信先を `MH_BRIDGE_RECOVERY_TMUX_PANE` に戻します。

これは、外出先でモバイル UI しか触れず、間違った tmux ペインが映ってしまった場合の復旧用です。

### Tailscale でのリモート利用

いちばん安全なのは:

    ./scripts/run-operator-once.sh --profile qwen3-realtime --no-attach
    tailscale serve --bg 8765

その後、スマホやタブレットから Tailscale Serve の URL を開きます。

### トラブルシュート

PTT 文字起こしが返らない:

- `curl -sS http://127.0.0.1:8091/health`
- `run-operator-stack.sh` のログで timeout や上流設定エラーを確認

Realtime ASR に接続できない:

- `curl -sS http://127.0.0.1:8090/v1/models`
- `MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime` を確認
- VRAM が足りなければ `REALTIME_ASR_GPU_MEMORY_UTILIZATION` を下げる

モバイルで違うペインが映る:

- `Esc` を 4 回素早く押して隠し復旧
- `run-operator-once.sh` 起動なら、既定でエージェントペインへ戻る

### 関連ファイル

- `scripts/run-face-app.sh`
- `scripts/run-operator-once.sh`
- `scripts/run-operator-stack.sh`
- `face-app/dist/index.js`
- `face-app/dist/operator_bridge.js`
- `face-app/public/app.js`
- `face-app/public/operator_keyboard_ptt.js`
