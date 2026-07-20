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

Local browser access uses the same `?auth_token=<token>` bootstrap. Open
`http://127.0.0.1:8765/?auth_token=<token>` once, then bookmark the clean URL
shown after authentication. Repeat the bootstrap if the cookie expires or the
token changes. If you also run UFW with default deny incoming, see the README's
`Binding to 0.0.0.0` section for the Docker bridge allow rule and the
shell-inheritance note for the token.

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

`./scripts/run-face-app.sh` は、フェイス画面と音声出力だけを使いたい場合に選びます。この経路では
`FACE_OPERATOR_PANEL_ENABLED=0` が既定値なので、明示的に有効化しない限りオペレーターパネルは
表示されません。

`./scripts/run-operator-once.sh --profile qwen3-realtime` は、実際のモバイル運用における現在の
推奨フル構成です。実エージェントの tmux ペインを自動で特定し、
`MH_BRIDGE_TMUX_PANE` と `MH_BRIDGE_RECOVERY_TMUX_PANE` の両方をスタックへ渡します。

`./scripts/run-operator-stack.sh` を直接起動する方法は、tmux ペインの接続先や起動構成を自分で
管理したい場合に使います。

### クイックスタート

フェイス画面だけを起動する最小構成:

    ./scripts/setup.sh
    ./scripts/run-face-app.sh

推奨フル構成:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

最初はエージェント側のペインをシェルとして開く場合:

    ./scripts/run-operator-once.sh --profile qwen3-realtime --agent-shell

デバッグのため、意図的にスタック側のペインをミラーする場合:

    ./scripts/run-operator-once.sh --bridge-target stack

### 音声出力先と UI モード

`FACE_AUDIO_TARGET`:

- `browser`（リモート向けの推奨）: 接続中のブラウザや AtomS3R などへだけ音声を送ります。
  ワーカーのリモート先読み（既定では約900 ms先）と、ブラウザ／Atom 側の FIFO キューが
  有効になり、長文を読むときの文と文の間が大幅に短くなります。PC のブラウザ、モバイル
  ブラウザ、AtomS3R のいずれでも利用できます。
- `local`: ホストのスピーカーだけで再生します。画面のない PC で、ワーカーからローカルの
  音声デバイスへ直接出力したい場合に使います。
- `both`: ホストのスピーカーで再生しながら、リモートにも送信します。PC のスピーカーと
  ブラウザ／Atom を同時に使う場合に便利です。ただし、このモードではワーカーの先読みが
  **無効**になります。ローカル再生のクロックを早めに進められないため、リモート側には従来の
  「合成 → 送信 → 再生完了待ち」の間が残ります。

`--ui-mode <auto|pc|mobile>` / `FACE_UI_MODE`:

- `auto`: 画面の条件に応じて自動的に選択します。
- `pc`: デスクトップ向けです。右側の `Debug Values` パネルは、既定では非表示です。
- `mobile`: モバイル向けのオーバーレイを表示します。

`run-face-app.sh` は `FACE_OPERATOR_PANEL_ENABLED=0` が既定、`run-operator-stack.sh` は `FACE_OPERATOR_PANEL_ENABLED=1` を強制します。

### フルオペレータースタックの中身

`run-operator-once.sh` は tmux セッションを作成または再利用し、ウィンドウを2つのペインへ
分割します。0番のペインでエージェントを、1番のペインで統合スタックを起動します。
ブリッジの接続先は、既定で0番のペインです。

また、オペレーターペインの環境には、`MH_FACE_AGENT_ID=__operator__` と
`MH_FACE_AGENT_LABEL=Operator` を設定します。`run-operator-stack.sh` がオプションの
MCP サーバーを起動する場合、そのサーバーも同じオペレーター識別子へ関連付けられます。
フェイスツールは `agent_id=__operator__` を自動補完し、異なる ID が明示された呼び出しを
拒否します。

ヘルパーペインには、生成時に割り当てられたヘルパー ID を渡します。Docker 経由でヘルパーを
起動する場合は、`docker exec -e` で識別子を渡します。識別子が関連付けられていない別の
MCP サーバーを使う場合は、`face_ping`、`face_event`、`face_say` のすべての呼び出しで
`agent_id` を明示してください。

<a id="ja-docker-and-helper-agent-commands"></a>
### Docker とヘルパーエージェントのコマンド

主オペレーターのコマンドとヘルパーエージェントの起動テンプレートは別です。

- `--agent-cmd <command>` は主オペレーターペインを起動します。
- `MH_AGENT_DEFAULT_CMD=<command>` は、あとでヘルパーエージェントを生成するときに `face-app` が使うテンプレートです。

`run-operator-once.sh` は、オペレーターペインの環境に `MH_FACE_AGENT_ID=__operator__` を
設定します。ただし、`--agent-cmd` に渡された Docker コマンド自体は書き換えません。
主オペレーターを Docker 経由で動かす場合は、そのコマンドにオペレーター識別子を明示して
ください。

```bash
./scripts/run-operator-once.sh --profile realtime \
  --agent-cmd 'docker exec -it -e MH_FACE_AGENT_ID=__operator__ -e MH_FACE_AGENT_LABEL=Operator agent-container agent-cli'
```

ヘルパーエージェントは `face-app` が作成し、各ヘルパーの ID も把握しているため、扱いが
異なります。`MH_AGENT_DEFAULT_CMD` が `docker exec` で始まる場合、`face-app` はコンテナ名の
前にヘルパー識別子を挿入します。

```bash
MH_AGENT_DEFAULT_CMD='docker exec -it agent-container agent-cli' \
  ./scripts/run-operator-once.sh --profile realtime
```

`helper-1` というヘルパーの場合、実質的には次のような起動になります。

```bash
docker exec -it -e MH_FACE_AGENT_ID=helper-1 -e MH_FACE_AGENT_LABEL=helper-1 agent-container agent-cli
```

ヘルパーテンプレートが `docker exec` でない場合は、通常のプロセス環境としてコマンドの前に付けます。

```bash
env MH_FACE_AGENT_ID=helper-1 MH_FACE_AGENT_LABEL=helper-1 agent-cli
```

この設定により、エージェントプロセスと、同じプロセス環境から起動された MCP サーバーへ
識別子が渡ります。`MH_FACE_AGENT_ID` があれば、MCP のフェイスツールは `agent_id` を
自動補完します。異なる ID が明示されていた場合は、修正方法を添えて拒否します。識別子が
関連付けられていない別の MCP サーバーを使う場合は、`face_ping`、`face_event`、`face_say` の
すべての呼び出しで `agent_id` を明示してください。

エージェントプロセスが Docker の別ネットワーク名前空間で動く場合は、README にある
`FACE_WS_HOST=0.0.0.0` の説明も参照してください。ループバック以外へ face-app をバインドする
場合は、`MH_FACE_AUTH_TOKEN` が必須です。スタックを起動する前にシェルへ設定すると、
`face-app`、オペレーターブリッジ、スタックが任意で起動する MCP サーバーへ、同じトークンが
引き継がれます。

`run-operator-stack.sh` は、次のコンポーネントを起動します。

- `face-app`
- `operator-bridge`
- バッチ処理用の `asr-worker`（無効化しない限り）
- 任意のリアルタイム ASR（`run-vllm-voxtral.sh`、有効時）

`run-operator-bridge.sh` は 1 つの tmux ペインだけをミラーし、承認済みの入力を `tmux send-keys` でそのペインへ送ります。

### tmux ペインの接続先

主なブリッジ用の環境変数:

<details>
<summary>Bridge 環境変数</summary>

- `MH_BRIDGE_TMUX_PANE`: ミラー対象かつ入力送信先
- `MH_BRIDGE_RECOVERY_TMUX_PANE`: 隠し復旧時の安全な既定復旧先
- `MH_BRIDGE_RESTART_COMMAND`: `Restart` ボタンなどで使う再開コマンド
- `MH_BRIDGE_RESTART_PRE_KEYS`: 再開コマンド前に送るキー
- `MH_BRIDGE_MIRROR_LINES`: terminal tail 行数
- `MH_BRIDGE_MIRROR_INTERVAL_MS`: ミラー発行間隔

</details>

`run-operator-stack.sh` を tmux 内で起動した場合は、`TMUX_PANE` を自動的に利用できます。
`run-operator-once.sh` を使う場合は、重要な接続先をスクリプトが自動で設定します。

`run-operator-once.sh` で選べるプロファイル:

- `--profile default`: Kokoro TTS + バッチ ASR のみ
- `--profile realtime`: Kokoro TTS + Voxtral リアルタイム ASR + Parakeet フォールバック
- `--profile qwen3`: Qwen3 TTS + バッチ ASR のみ
- `--profile qwen3-realtime`: Qwen3 TTS + Voxtral リアルタイム ASR + Parakeet フォールバック

### ASR モード

ASR は 2 系統あります。

バッチ ASR:

- ブラウザが `MediaRecorder` で録音
- `POST /api/operator/asr?lang=ja|en`
- `face-app` から `asr-worker` へ転送
- `asr-worker` が Parakeet で日本語・英語のバッチ文字起こしを実行
- AtomS3R の連続 VAD は WebSocket で `atom_audio_frame` PCM を送り、`face-app` で発話区間を切ってから同じバッチ ASR とオペレーター応答経路を再利用

任意のリアルタイム ASR:

- ブラウザが PCM16 チャンクを WebSocket で送る
- `face-app` が Voxtral の vLLM リアルタイム WebSocket へ中継
- 話している途中から増分テキストを表示
- リアルタイム側の出力が空か明らかに不正な場合は、バッチ側のフォールバックが自動的に動く

音声ターンを受理したときの応答には、ローカルの固定テンプレートを使います。バッチ ASR が
空でないターンを受理すると、`face-app` は要求または検出された言語に応じて、`Checking.`、
`One moment.`、`Let me check.`、`確認します。`、`少々お待ちください。`、`確認しますね。` などの
短いフレーズを話します。同じ文を吹き出しにも表示するため、ミュート中でも受理したことを
確認できます。文は言語と入力元ごとに順番を変えます。無効にするには
`MH_FIXED_ACK_ENABLED=0` を設定してください。この経路では、コーディングエージェントや LLM に
応答文を生成させません。

AtomS3R の連続 VAD は、Atom ファームウェアの `continuous_vad_enabled` だけで制御します。
デバイス側のダブルタップ、または `scripts/atoms3r-provision.mjs --vad-on` / `--vad-off` で
切り替えられます。デバイス側でオフにするとマイクフレームは送信されず、PC 側のブリッジは
組み込まれたまま、何も処理しない状態になります。

PC 側ブリッジには、差し替え可能な VAD バックエンドが2つあります。
`MH_ATOM_VAD_BACKEND` で選択します。

- `rms`（既定）: 組み込みの決定的な RMS エネルギーゲートです。軽量で別ワーカーは不要ですが、
  閾値を超える環境音はすべて発話として検出されます。静かな部屋に向いています。
- `silero`: 各フレームを `silero-vad-worker` の HTTP サービスへ転送し、機械学習によって
  発話か非発話かを判定します。駅、路上、カフェなど、環境音のある場所に向いています。
  CPU 使用時間の目安は、1フレームあたり1〜3 msです。`scripts/run-silero-vad-worker.sh` で
  起動します。このバックエンドを選ぶと、`run-operator-stack.sh` がワーカーを自動的に
  起動します。
  `MH_SILERO_VAD_BASE_URL`（既定値 `http://127.0.0.1:8092`）と
  `MH_SILERO_VAD_THRESHOLD`（既定値 `0.5`）で調整できます。

AtomS3R のファームウェアにも独自の RMS ゲートがあります。`vad_rms` として NVS に保存し、
`scripts/atoms3r-provision.mjs --vad-rms` で設定します。モバイル回線の通信量を抑えるため、
エネルギーの小さいフレームは送信しません。騒がしい場所で `MH_ATOM_VAD_BACKEND=silero` を
使う場合は、Silero の判別力を活かせるよう、ファームウェア側のゲートを低め（約0.005）に
設定します。

ファームウェアの書き込み、USB プロビジョニング、ADPCM 圧縮、調整項目
（`MH_ATOM_VAD_END_SILENCE_MS` / `_THRESHOLD_RMS` / `_MAX_UTTERANCE_MS`、`vad_tail`）、
PTT、トラブルシューティングについては、
**[AtomS3R Voice Guide](atoms3r-voice.md#japanese)**を参照してください。

主なバッチ ASR 変数:

<details>
<summary>バッチ ASR 環境変数</summary>

- `MH_OPERATOR_ASR_BASE_URL`
- `MH_OPERATOR_ASR_ENDPOINT_URL`
- `MH_OPERATOR_ASR_TIMEOUT_MS`
- `MH_OPERATOR_ASR_MODEL_JA`
- `MH_OPERATOR_ASR_MODEL_EN`
- `MH_FIXED_ACK_ENABLED=0`: 固定受理応答の音声を無効化
- `MH_ATOM_VAD_BACKEND=rms|silero`（既定値 `rms`）: PC 側の VAD バックエンドを選択
- `MH_SILERO_VAD_BASE_URL`: silero-vad-worker の URL（既定値 `http://127.0.0.1:8092`）
- `MH_SILERO_VAD_THRESHOLD`: Silero の発話確率しきい値（既定値 `0.5`）
- `MH_STACK_START_SILERO_VAD=0`: 外部で起動済みの場合に silero-vad-worker の自動起動を省略

</details>

主なリアルタイム ASR 変数:

<details>
<summary>リアルタイム ASR 環境変数</summary>

- `MH_OPERATOR_REALTIME_ASR_ENABLED=1`
- `MH_OPERATOR_REALTIME_ASR_WS_URL`
- `MH_OPERATOR_REALTIME_ASR_MODEL`
- `MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ`
- `MH_STACK_START_REALTIME_ASR=1`
- `REALTIME_ASR_GPU_MEMORY_UTILIZATION`
- `MH_STACK_SKIP_ASR=1`

</details>

### 推奨起動モード

通常運用では、まず `run-operator-once.sh --profile ...` を使ってください。ブリッジの接続先が
安全に設定され、README などの説明で使うプロファイル名とも一致します。

Parakeet のみ（必要な VRAM が最小、リアルタイム ASR なし）:

    ./scripts/run-operator-once.sh --profile default

Voxtral リアルタイム ASR + Parakeet フォールバック（現在の推奨、VRAM は多め）:

    ./scripts/run-operator-once.sh --profile realtime

Qwen3 TTS + バッチ ASR のみ:

    ./scripts/run-operator-once.sh --profile qwen3

Qwen3 TTS + Voxtral リアルタイム ASR + Parakeet フォールバック:

    ./scripts/run-operator-once.sh --profile qwen3-realtime

### 低レベルな `run-operator-stack.sh` 相当例

以下は、tmux ペインの接続先やスタックの構成を自分で管理したい場合だけ使ってください。

Parakeet のみ（必要な VRAM が最小、リアルタイム ASR なし）:

    npm run setup
    MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral リアルタイム ASR + Parakeet フォールバック（現在の推奨、VRAM は多め）:

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

Voxtral リアルタイム ASR のみ（ハイブリッド構成より VRAM を節約）:

    npm run setup:all
    MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_STACK_SKIP_ASR=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

すでに別ターミナルで `./scripts/run-vllm-voxtral.sh` を起動している場合:

    MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh

### オペレーター UI の挙動

オペレーターパネルは `FACE_OPERATOR_PANEL_ENABLED=1` のときだけ表示されます。

フルオペレータースタックでは:

- `Esc` は常時表示
- `Restart` は復旧時またはオフライン時のみ
- `↑`, `Select`, `↓` は常時表示
- デスクトップでは `Esc` の近くに `?` ボタンを表示（キーボード操作の早見表）
- ターミナルミラーは読み取り専用

`PTT JA` / `PTT EN` の文字起こしは、テキスト入力欄の末尾固定ではなく、現在のカーソル位置へ入ります。

マルチエージェント操作は、次の単純なモデルに寄せています。

- デスクトップは通常のフェイス／オペレーターレイアウトを維持しつつ、オペレーターペイン内に
  現在のエージェントを示すバーを表示します。
- そのバーを押すと、主オペレーターしかいない状態でも `Agents` 画面を開けます。
- `+Agent` は ID、ブランチ、ワークツリーを安全な既定値で自動生成し、補助エージェントを追加します。
- デスクトップのタイルやモバイルの一覧行を押すと、表示だけでなく、オペレーターが実際に
  接続するエージェントも切り替わります。
- 通常時に表示される操作は `Delete` だけです。裏側では、ペインの停止と切り離し、
  ワークツリーの掃除、実行状態の記録削除までまとめて行います。
- 組み込みの `operator` 行は主ペインを表しており、補助エージェントの削除操作では消えません。
- tmux を完全に終了してから `./scripts/run-operator-once.sh` で新規起動した場合も、補助
  エージェントのワークツリーが残っていれば、新しい tmux ペインを作って復元します。
  ワークツリーがなければ、`missing` として再表示します。

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
- `PageUp` / `PageDown`: ターミナルミラーをスクロール

### 隠し復旧（モバイル）

モバイルで `Esc` を短時間に4回押すと、4回目は通常の Escape キーとして送信されず、
`POST /api/operator/recover-default` を呼ぶ隠し復旧になります。`operator-bridge` は要求を受け、
ミラー対象と入力送信先を `MH_BRIDGE_RECOVERY_TMUX_PANE` へ戻します。

これは、外出先でモバイル UI しか触れず、間違った tmux ペインが映ってしまった場合の復旧用です。

### Tailscale でのリモート利用

いちばん安全なのは:

    export MH_FACE_AUTH_TOKEN="$(openssl rand -base64 32)"
    ./scripts/run-operator-once.sh --profile qwen3-realtime --no-attach
    tailscale serve --bg 8765

その後、スマホやタブレットから初回だけ token 付きの Tailscale Serve URL を開きます。

    https://<tailscale-host>:8443/?auth_token=<token>

ブラウザは `sessionStorage` にトークンを保存し、face-app も同じオリジンの `mh_face_auth`
Cookie を設定します。その後、表示 URL からトークンを取り除くため、初回設定後はモバイルの
ホーム画面ショートカットもトークンなしの URL で使えます。ファイアウォールと Tailscale の
境界を主な防御として維持してください。このトークンは、誤って外部へ公開した場合や tailnet
内部での誤用に備える、アプリケーション層の追加防御です。

PC ブラウザからローカルで接続する場合も、同じ `?auth_token=<token>` 手順を使います。
`http://127.0.0.1:8765/?auth_token=<token>` を一度だけ開き、認証後に表示されるトークンなしの
URL をブックマークしてください。Cookie の期限が切れた場合やトークンを変更した場合は、
この初回認証をやり直します。UFW を `default deny incoming` で運用する場合の Docker
ブリッジ許可ルールと、トークンをシェルへ引き継ぐ方法（`~/.profile` から読み込む設定）は、README の
「docker / リモートエージェント向けに 0.0.0.0 でバインドする場合」を参照してください。

### 通常の終了方法

通常のオペレーター終了では `tmux kill-server` を使わず、tmux のウィンドウまたはセッションを
閉じます。

推奨:

    tmux kill-window -t agent:operator

このオペレータースタック専用のセッションで運用している場合:

    tmux kill-session -t agent

再起動や復旧には `./scripts/restart-operator-stack-in-place.sh` を使い、場当たり的な tmux ペイン
操作は避けてください。通常運用中にペインが消えた場合は、ブラウザ UI 上の別のライフサイクル
ではなく、復旧対象として扱います。

一方、ウィンドウやセッションを完全に閉じてから `./scripts/run-operator-once.sh` で立ち上げ直すと、
face-app は起動時の照合処理で、保存済みの補助エージェント記録を読み込みます。ワークツリーが
残っているエージェントには新しい tmux ペインを割り当てます。ワークツリーがないエージェントは
`missing` のまま残し、`Delete` だけを実行できる状態にします。

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
