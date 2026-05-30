# Operator Stack and ASR Guide

This guide collects the detailed runtime notes for the operator panel, `operator-bridge`, browser PTT, batch ASR, optional realtime ASR, and remote/mobile operation. The top-level [README](../../README.md) stays shorter on purpose; use this file when you are operating the mobile stack itself.

[English](#english) | [日本語](#japanese)

<a id="english"></a>
## English

### Which launcher to use

Use `./scripts/run-face-app.sh` when you only want the face UI and local/browser speech output. This path now starts `face-app` with `FACE_OPERATOR_PANEL_ENABLED=0` by default, so the browser shows the simple face-oriented UI and hides the operator panel unless you explicitly override it.

Use `./scripts/run-operator-once.sh --profile qwen3-realtime` when you want the full two-pane workflow. This is the current recommended path for real mobile operation because it resolves the real agent tmux pane automatically and passes both `MH_BRIDGE_TMUX_PANE` and `MH_BRIDGE_RECOVERY_TMUX_PANE` into the stack.

Use `./scripts/run-operator-stack.sh` directly only when you intentionally want to manage tmux pane targeting and startup wiring yourself.

Profile shorthand for `run-operator-once.sh`:

- `--profile default`: Kokoro TTS + batch ASR only
- `--profile realtime`: Kokoro TTS + Voxtral realtime ASR + Parakeet fallback
- `--profile qwen3`: Qwen3 TTS + batch ASR only
- `--profile qwen3-realtime`: Qwen3 TTS + Voxtral realtime ASR + Parakeet fallback

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

- `browser` (recommended for remote sinks): send audio to connected browser clients only. PC browser tabs, mobile browsers, and the AtomS3R bridge all benefit from the TTS worker's remote prefetch (~900 ms lead) plus the browser/Atom FIFO queues — long multi-sentence answers play with much shorter inter-chunk gaps.
- `local`: play on the host speaker only. Use this for a headless PC where you want the worker to drive a local sound device directly.
- `both`: play on the host speaker and broadcast to remote sinks. Convenient when you want PC speaker output alongside a browser/Atom listener, but worker prefetch is **disabled** in this mode (the local clock cannot be cut short), so remote sinks hear the older synthesize-then-send-then-play pacing.

All launchers also accept `--ui-mode <auto|pc|mobile>` (the CLI form of `FACE_UI_MODE`):

- `auto`: choose the layout automatically
- `pc`: desktop-oriented operator layout (the right-side `Debug Values` panel is hidden by default)
- `mobile`: mobile-focused operator overlay

`run-face-app.sh` defaults to `FACE_OPERATOR_PANEL_ENABLED=0`. `run-operator-stack.sh` forces `FACE_OPERATOR_PANEL_ENABLED=1`.

### Full operator stack internals

`run-operator-once.sh` creates or reuses a tmux session, splits a window into two panes, launches your coding agent in pane 0, launches the integrated stack in pane 1, and wires the bridge target to pane 0 by default.

It also exports `MH_FACE_AGENT_ID=__operator__` and `MH_FACE_AGENT_LABEL=Operator` into the operator pane. When `run-operator-stack.sh` starts the optional MCP server, it binds that MCP server to the same operator identity so face tools can auto-fill `agent_id=__operator__` and reject conflicting explicit ids. Helper panes receive their assigned helper id at spawn time, and Docker-based helper commands receive that identity through `docker exec -e`. Clients that run a separate unbound MCP server must pass `agent_id` explicitly on every `face_ping`, `face_event`, and `face_say` call.

### Docker and helper agent commands

The primary operator command and the helper-agent command template are separate:

- `--agent-cmd <command>` starts the primary operator pane.
- `MH_AGENT_DEFAULT_CMD=<command>` is the template `face-app` uses later when it spawns helper agents.

`run-operator-once.sh` sets `MH_FACE_AGENT_ID=__operator__` in the operator pane environment, but it does not rewrite an arbitrary Docker command passed to `--agent-cmd`. If the primary operator itself runs through Docker, include the operator identity in that command:

```bash
./scripts/run-operator-once.sh --profile realtime \
  --agent-cmd 'docker exec -it -e MH_FACE_AGENT_ID=__operator__ -e MH_FACE_AGENT_LABEL=Operator agent-container agent-cli'
```

Helper agents are different because `face-app` creates them and knows each helper id. When `MH_AGENT_DEFAULT_CMD` starts with `docker exec`, `face-app` inserts the helper identity before the container name:

```bash
MH_AGENT_DEFAULT_CMD='docker exec -it agent-container agent-cli' \
  ./scripts/run-operator-once.sh --profile realtime
```

For a helper named `helper-1`, that helper launch is effectively:

```bash
docker exec -it -e MH_FACE_AGENT_ID=helper-1 -e MH_FACE_AGENT_LABEL=helper-1 agent-container agent-cli
```

When the helper template is not a `docker exec` command, `face-app` prefixes it with normal process environment variables instead:

```bash
env MH_FACE_AGENT_ID=helper-1 MH_FACE_AGENT_LABEL=helper-1 agent-cli
```

This makes the identity available to the agent process and to MCP servers started from that process environment. The MCP face tools auto-fill `agent_id` from `MH_FACE_AGENT_ID` when available and reject conflicting explicit ids with remediation guidance. Clients that run a separate unbound MCP server should pass `agent_id` explicitly on every `face_ping`, `face_event`, and `face_say` call.

If the agent process runs in a separate Docker network namespace, also see the `FACE_WS_HOST=0.0.0.0` guidance in the README. Non-loopback face-app binds require `MH_FACE_AUTH_TOKEN`; export it in the shell before starting the stack so `face-app`, the operator bridge, and any stack-started MCP server inherit the same token.

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
- AtomS3R continuous VAD streams `atom_audio_frame` PCM over WebSocket, segments turns in `face-app`, then reuses the same batch ASR and operator response path

Optional realtime ASR:

- browser streams PCM16 chunks over the existing websocket
- `face-app` relays them to a Voxtral vLLM realtime websocket
- incremental text appears while you are still speaking
- batch fallback can still run when realtime output is clearly bad or empty

Voice turn acknowledgement is local and template-based. After batch ASR accepts a non-empty turn, `face-app` speaks and displays a short fixed phrase such as `Checking.`, `One moment.`, `Let me check.`, `確認します。`, `少々お待ちください。`, or `確認しますね。` using the requested or detected ASR language. The phrase rotates per language and source, and the same text appears in the speech bubble so muted operation still has visible feedback. Set `MH_FIXED_ACK_ENABLED=0` to disable this. This path does not ask the coding agent or an LLM to generate acknowledgement text.

AtomS3R continuous VAD is gated solely by the Atom firmware setting (`continuous_vad_enabled`, toggled by device double-tap or `scripts/atoms3r-provision.mjs --vad-on` / `--vad-off`). When the device is off, it does not stream mic frames, so the PC-side bridge has nothing to process; the bridge is always installed and is a no-op in that case.

The PC-side bridge supports two interchangeable VAD backends, selected by `MH_ATOM_VAD_BACKEND`:

- `rms` (default): the built-in deterministic RMS-energy gate. Lightweight, no extra worker required, but ambient noise above the threshold registers as speech. Good for quiet rooms.
- `silero`: forwards every frame to the `silero-vad-worker` HTTP service for ML-based classification. Robust against street / station / cafe noise, ~1–3 ms CPU per frame. Start the worker with `scripts/run-silero-vad-worker.sh` (run-operator-stack.sh launches it automatically when this backend is selected). Configure via `MH_SILERO_VAD_BASE_URL` (default `http://127.0.0.1:8092`) and `MH_SILERO_VAD_THRESHOLD` (default 0.5).

Note that the AtomS3R firmware applies its own RMS energy gate (`vad_rms`, NVS, set via `scripts/atoms3r-provision.mjs --vad-rms`) to skip silent frames over mobile-tethered links. When `MH_ATOM_VAD_BACKEND=silero` is used in a noisy environment, keep the firmware gate low (~0.005) so Silero sees the marginal-energy frames where its discriminative advantage matters. For flashing, USB provisioning, ADPCM compression, every tuning knob (`MH_ATOM_VAD_END_SILENCE_MS` / `_THRESHOLD_RMS` / `_MAX_UTTERANCE_MS`, `vad_tail`), PTT, and troubleshooting, see the **[AtomS3R Voice Guide](atoms3r-voice.md#english)**.

The key batch ASR variables are:

<details>
<summary>Batch ASR environment variables</summary>

- `MH_OPERATOR_ASR_BASE_URL`
- `MH_OPERATOR_ASR_ENDPOINT_URL`
- `MH_OPERATOR_ASR_TIMEOUT_MS`
- `MH_OPERATOR_ASR_MODEL_JA`
- `MH_OPERATOR_ASR_MODEL_EN`
- `MH_FIXED_ACK_ENABLED=0` disables fixed acknowledgement speech
- `MH_ATOM_VAD_BACKEND=rms|silero` (default `rms`) — selects the PC-side VAD backend
- `MH_SILERO_VAD_BASE_URL` — silero-vad-worker URL (default `http://127.0.0.1:8092`)
- `MH_SILERO_VAD_THRESHOLD` — Silero speech-probability threshold (default `0.5`)
- `MH_STACK_START_SILERO_VAD=0` — skip auto-starting silero-vad-worker (use when running it elsewhere)

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

Prefer these `run-operator-once.sh --profile ...` launchers for normal operation. They wire the bridge target safely and match the profile terminology used elsewhere in the docs.

Parakeet only (lowest VRAM, no realtime):

    ./scripts/run-operator-once.sh --profile default

Voxtral realtime plus Parakeet fallback (best current experience, higher VRAM):

    ./scripts/run-operator-once.sh --profile realtime

Qwen3 TTS plus batch ASR:

    ./scripts/run-operator-once.sh --profile qwen3

Qwen3 TTS plus Voxtral realtime ASR and Parakeet fallback:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

### Low-level `run-operator-stack.sh` equivalents

Use these only when you intentionally manage tmux pane targeting and stack wiring yourself.

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

Multi-agent control now follows one simple model:

- Desktop keeps the normal face/operator layout and adds a current-agent bar inside the operator pane.
- Clicking that bar opens the `Agents` surface even when only the primary operator exists.
- `+Agent` creates a helper agent with safe auto-generated id/branch/worktree defaults.
- Clicking a desktop tile or mobile list row changes the real operator focus target, not just the highlight.
- `Delete` is the only normal visible lifecycle action; it performs pane stop/detach, worktree cleanup, and runtime record purge behind the scenes.
- The built-in `operator` entry represents the primary pane and is not removed through the helper-agent delete flow.
- After a full tmux shutdown and a fresh `./scripts/run-operator-once.sh`, helper agents are recreated from saved worktrees when those worktrees still exist; otherwise they reappear as `missing`.

### Keyboard shortcuts

Desktop keyboard shortcuts currently mirror the UI:

- `Space` (hold 1 second): `PTT JA`
- `Shift+Space` (hold 1 second): `PTT EN`
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

    export MH_FACE_AUTH_TOKEN="$(openssl rand -base64 32)"
    ./scripts/run-operator-once.sh --profile qwen3-realtime --no-attach
    tailscale serve --bg 8765

Then open the served URL from the phone or tablet with the token once:

    https://<tailscale-host>:8443/?auth_token=<token>

The browser stores the token in `sessionStorage`, and face-app also sets an `mh_face_auth` cookie for that origin. The visible URL is then cleaned, so mobile home-screen shortcuts can use the clean URL after the first token bootstrap. Keep firewall/Tailscale rules as the primary network boundary; the token is an application-layer backstop for accidental exposure or tailnet-internal misuse.

Local browser access uses the same `?auth_token=<token>` bootstrap; bookmark `http://127.0.0.1:8765/?auth_token=<token>` once. If you also run UFW with default deny incoming, see the README's `Binding to 0.0.0.0` section for the Docker bridge allow rule and the shell-inheritance note for the token.

### Normal shutdown

Use tmux window or session shutdown, not `tmux kill-server`, for ordinary operator shutdown.

Recommended:

    tmux kill-window -t agent:operator

If the whole session exists only for this operator stack:

    tmux kill-session -t agent

Use `./scripts/restart-operator-stack-in-place.sh` for restart/recovery, not ad hoc tmux pane commands. Pane loss during normal operation is treated as a recovery problem, not as a separate user-facing lifecycle mode in the browser UI.

If you intentionally shut down the whole tmux window or session and later start again with `./scripts/run-operator-once.sh`, the face-app startup reconcile now checks saved helper records. Existing helper worktrees get new tmux panes; missing worktrees are left in the dashboard as `missing` so they can be deleted cleanly.

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

- `browser`（リモート向けの推奨）: 接続中のブラウザ／AtomS3R などへのみ送出。worker のリモート先読み（既定 ~900 ms リード）とブラウザ／Atom 側 FIFO キューが有効になり、長文の文間ギャップが大幅に短くなります。PC ブラウザ・スマホブラウザ・AtomS3R いずれも対象。
- `local`: ホストスピーカーのみ。ヘッドレス PC で worker に直接ローカル音声デバイスを叩かせたいとき。
- `both`: ホストスピーカーで再生しつつリモートにもブロードキャスト。PC スピーカーとブラウザ／Atom を同時に使いたいとき便利だが、worker の先読みはこのモードでは **無効**（ローカル再生クロックを早めに切れない）のため、リモート側は従来の「合成→送信→再生完了待ち」の間が残ります。

`--ui-mode <auto|pc|mobile>` / `FACE_UI_MODE`:

- `auto`: 画面条件に応じて自動選択
- `pc`: デスクトップ向け（右側 `Debug Values` パネルは既定で非表示）
- `mobile`: モバイル向けオーバーレイ

`run-face-app.sh` は `FACE_OPERATOR_PANEL_ENABLED=0` が既定、`run-operator-stack.sh` は `FACE_OPERATOR_PANEL_ENABLED=1` を強制します。

### フル operator stack の中身

`run-operator-once.sh` は tmux セッションを作成または再利用し、ウィンドウを 2 ペインに分け、0 番にエージェント、1 番に統合スタックを起動し、bridge の接続先を既定で 0 番へ向けます。

また、operator pane には `MH_FACE_AGENT_ID=__operator__` と `MH_FACE_AGENT_LABEL=Operator` を export します。`run-operator-stack.sh` が任意起動 MCP server を起動する場合、その MCP server も同じ operator identity に束縛され、face tools は `agent_id=__operator__` を自動補完し、矛盾する明示 id を拒否します。helper pane は spawn 時に割り当てられた helper id を受け取り、Docker 経由の helper command には `docker exec -e` でその identity が渡されます。別の未束縛 MCP server を使う client では `face_ping` / `face_event` / `face_say` の全 call に `agent_id` を明示してください。

<a id="ja-docker-and-helper-agent-commands"></a>
### Docker と helper agent の command

primary operator の command と helper-agent の起動テンプレートは別です。

- `--agent-cmd <command>` は primary operator pane を起動します。
- `MH_AGENT_DEFAULT_CMD=<command>` は、あとで helper agent を spawn するときに `face-app` が使うテンプレートです。

`run-operator-once.sh` は operator pane の環境に `MH_FACE_AGENT_ID=__operator__` を設定しますが、`--agent-cmd` に渡された任意の Docker command を書き換えるわけではありません。primary operator 自体を Docker 経由で動かす場合は、その command に operator identity を明示してください。

```bash
./scripts/run-operator-once.sh --profile realtime \
  --agent-cmd 'docker exec -it -e MH_FACE_AGENT_ID=__operator__ -e MH_FACE_AGENT_LABEL=Operator agent-container agent-cli'
```

helper agent は `face-app` が作成し、各 helper id を知っているため扱いが異なります。`MH_AGENT_DEFAULT_CMD` が `docker exec` で始まる場合、`face-app` はコンテナ名の前に helper identity を挿入します。

```bash
MH_AGENT_DEFAULT_CMD='docker exec -it agent-container agent-cli' \
  ./scripts/run-operator-once.sh --profile realtime
```

`helper-1` という helper の場合、実質的には次のような起動になります。

```bash
docker exec -it -e MH_FACE_AGENT_ID=helper-1 -e MH_FACE_AGENT_LABEL=helper-1 agent-container agent-cli
```

helper テンプレートが `docker exec` でない場合は、通常の process environment として command の前に付けます。

```bash
env MH_FACE_AGENT_ID=helper-1 MH_FACE_AGENT_LABEL=helper-1 agent-cli
```

これは agent process と、その process environment から起動された MCP server に identity を渡します。MCP face tools は `MH_FACE_AGENT_ID` があれば `agent_id` を自動補完し、矛盾する明示 id を対応方法つきで拒否します。別の未束縛 MCP server を使う client では、`face_ping` / `face_event` / `face_say` の全 call に `agent_id` を明示してください。

agent process が Docker の別 network namespace で動く場合は、README の `FACE_WS_HOST=0.0.0.0` の説明も参照してください。ループバック外へ face-app をバインドする場合は `MH_FACE_AUTH_TOKEN` が必須です。stack 起動前の shell で export しておくと、`face-app`、operator bridge、stack が任意起動する MCP server が同じ token を継承します。

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

`run-operator-once.sh` の profile 対応:

- `--profile default`: Kokoro TTS + batch ASR のみ
- `--profile realtime`: Kokoro TTS + Voxtral realtime ASR + Parakeet fallback
- `--profile qwen3`: Qwen3 TTS + batch ASR のみ
- `--profile qwen3-realtime`: Qwen3 TTS + Voxtral realtime ASR + Parakeet fallback

### ASR モード

ASR は 2 系統あります。

batch ASR:

- ブラウザが `MediaRecorder` で録音
- `POST /api/operator/asr?lang=ja|en`
- `face-app` から `asr-worker` へ転送
- `asr-worker` が Parakeet で変換
- AtomS3R の連続 VAD は WebSocket で `atom_audio_frame` PCM を送り、`face-app` で発話区間を切ってから同じ batch ASR と operator response 経路を再利用

任意の realtime ASR:

- ブラウザが PCM16 チャンクを websocket で送る
- `face-app` が Voxtral の vLLM realtime websocket へ中継
- 話している途中から増分テキストを表示
- 空振りや明らかな誤認識時は batch 側へ再確認できる

音声ターンの acknowledgement はローカルな固定テンプレートです。batch ASR が空でないターンを受理すると、`face-app` は要求または検出された ASR 言語に応じて `Checking.`、`One moment.`、`Let me check.`、`確認します。`、`少々お待ちください。`、`確認しますね。` のような短い固定フレーズを話し、同じ文を吹き出しにも表示します。文は言語と入力元ごとにローテーションするため、ミュート運用でも目で受理状態が分かります。無効化するには `MH_FIXED_ACK_ENABLED=0` を設定します。この経路では coding agent や LLM に acknowledgement 文を生成させません。

AtomS3R の連続 VAD は Atom firmware の `continuous_vad_enabled` 設定だけで制御されます（デバイス側のダブルタップ、または `scripts/atoms3r-provision.mjs --vad-on` / `--vad-off` でトグル）。デバイス側 OFF のときマイクフレームは送られないので、PC 側のブリッジは常に install されたまま no-op として動きます。

PC 側 bridge には差し替え可能な VAD バックエンドが 2 つあります。`MH_ATOM_VAD_BACKEND` で選択:

- `rms` (デフォルト): 組み込みの決定的 RMS エネルギーゲート。軽量で別ワーカー不要、静かな部屋向け。
- `silero`: 各フレームを `silero-vad-worker` HTTP サービスに転送し、ML ベースで speech/非 speech を判定。駅・路上・カフェなど環境音がある場所で有効。CPU 1〜3 ms/フレーム。`scripts/run-silero-vad-worker.sh` で起動（このバックエンドを選ぶと `run-operator-stack.sh` が自動で立ち上げます）。`MH_SILERO_VAD_BASE_URL` (デフォルト `http://127.0.0.1:8092`) と `MH_SILERO_VAD_THRESHOLD` (デフォルト 0.5) で調整。

AtomS3R firmware にも独自の RMS ゲート (`vad_rms`、NVS、`scripts/atoms3r-provision.mjs --vad-rms` で設定) が入っており、モバイル回線経由の帯域節約のため弱いフレームをそもそも送りません。`MH_ATOM_VAD_BACKEND=silero` を騒がしい場所で使う場合は、Silero の判別力を活かすため firmware 側ゲートを低め (~0.005) に保ちます。書き込み・USB プロビジョニング・ADPCM 圧縮・各チューニング (`MH_ATOM_VAD_END_SILENCE_MS` / `_THRESHOLD_RMS` / `_MAX_UTTERANCE_MS`、`vad_tail`)・PTT・トラブルシュートは **[AtomS3R Voice Guide](atoms3r-voice.md#japanese)** を参照。

主な batch ASR 変数:

<details>
<summary>batch ASR 環境変数</summary>

- `MH_OPERATOR_ASR_BASE_URL`
- `MH_OPERATOR_ASR_ENDPOINT_URL`
- `MH_OPERATOR_ASR_TIMEOUT_MS`
- `MH_OPERATOR_ASR_MODEL_JA`
- `MH_OPERATOR_ASR_MODEL_EN`
- `MH_FIXED_ACK_ENABLED=0`: 固定 acknowledgement 音声を無効化
- `MH_ATOM_VAD_BACKEND=rms|silero` (デフォルト `rms`): PC 側 VAD バックエンド選択
- `MH_SILERO_VAD_BASE_URL`: silero-vad-worker URL (デフォルト `http://127.0.0.1:8092`)
- `MH_SILERO_VAD_THRESHOLD`: Silero の speech 確率しきい値 (デフォルト `0.5`)
- `MH_STACK_START_SILERO_VAD=0`: silero-vad-worker の自動起動をスキップ (外部で起動済みのとき)

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

通常運用では、まず `run-operator-once.sh --profile ...` を使ってください。bridge の接続先を安全に埋められ、README など他の説明とも profile 名が一致します。

Parakeet のみ（最小 VRAM、realtime なし）:

    ./scripts/run-operator-once.sh --profile default

Voxtral realtime + Parakeet fallback（現在の本命、VRAM 多め）:

    ./scripts/run-operator-once.sh --profile realtime

Qwen3 TTS + batch ASR のみ:

    ./scripts/run-operator-once.sh --profile qwen3

Qwen3 TTS + Voxtral realtime ASR + Parakeet fallback:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

### 低レベルな `run-operator-stack.sh` 相当例

以下は tmux pane の接続先や stack 配線を自分で管理したい場合だけ使ってください。

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
- デスクトップでは `Esc` の近くに `?` ボタンを表示（キーボード操作の早見表）
- terminal mirror は読み取り専用

`PTT JA` / `PTT EN` の文字起こしは、テキスト入力欄の末尾固定ではなく、現在のカーソル位置へ入ります。

マルチエージェント操作は、次の単純なモデルに寄せています。

- デスクトップは通常の face/operator レイアウトを維持しつつ、operator pane 内に現在エージェントバーを表示します。
- そのバーを押すと、最初の 1 エージェント状態からでも `Agents` を開けます。
- `+Agent` は id / branch / worktree を安全な既定値で自動生成して補助エージェントを追加します。
- デスクトップのタイルやモバイルの一覧行を押すと、見た目だけではなく実際の operator の接続先が切り替わります。
- 通常の visible action は `Delete` のみで、裏側では pane の停止/切り離し、worktree cleanup、runtime record 削除までまとめて行います。
- 組み込みの `operator` 行は primary pane を表しており、helper agent の削除フローでは消しません。
- tmux を完全に終了してから `./scripts/run-operator-once.sh` で新規起動した場合も、helper agent の worktree が残っていれば新しい tmux pane を作って復元し、worktree が無ければ `missing` として再表示します。

### キーボードショートカット

- `Space`（1秒長押し）: `PTT JA`
- `Shift+Space`（1秒長押し）: `PTT EN`
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

    export MH_FACE_AUTH_TOKEN="$(openssl rand -base64 32)"
    ./scripts/run-operator-once.sh --profile qwen3-realtime --no-attach
    tailscale serve --bg 8765

その後、スマホやタブレットから初回だけ token 付きの Tailscale Serve URL を開きます。

    https://<tailscale-host>:8443/?auth_token=<token>

ブラウザは `sessionStorage` に token を保存し、face-app も同じ origin の `mh_face_auth` cookie を設定します。その後、表示 URL から token を取り除くため、初回 bootstrap 後はモバイルのホーム画面ショートカットも token なしのきれいな URL で使えます。firewall / Tailscale の境界を主な防御として維持し、この token は accidental exposure や tailnet 内部の誤用へのアプリ層の追加防御として扱ってください。

PC ブラウザでのローカルアクセスも同じ `?auth_token=<token>` 手順です。`http://127.0.0.1:8765/?auth_token=<token>` を一度だけ開き、その状態をブックマーク。UFW を `default deny incoming` で運用している場合の Docker bridge 許可ルールと、token のシェル継承(`~/.profile` で source する話)は README の `### docker / リモートエージェント向けに 0.0.0.0 でバインドする場合` を参照してください。

### 通常の終了方法

通常の operator 終了では `tmux kill-server` ではなく、tmux の window または session を閉じます。

推奨:

    tmux kill-window -t agent:operator

この operator stack 専用の session で運用している場合:

    tmux kill-session -t agent

再起動や復旧には `./scripts/restart-operator-stack-in-place.sh` を使い、ad hoc な tmux pane 操作は避けます。通常運用中の pane 消失は、ブラウザ UI 上の別 lifecycle ではなく復旧対象として扱います。

一方で、window や session を完全に閉じてから `./scripts/run-operator-once.sh` で立ち上げ直した場合は、face-app の起動時 reconcile が保存済み helper record を読みます。worktree が残っている helper には新しい tmux pane を割り当て、worktree が無い helper は `missing` として残し、`Delete` だけできる状態にします。

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
