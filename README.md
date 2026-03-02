# minimum-headroom

<p>
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/b3b0a1dd-ef19-49d0-bdaf-5068ee1a376c" />
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/fa7f65d5-f314-4118-90c7-3853fddd6668" />
</p>
<p>
  <img width="49%" alt="Image" src="https://github.com/user-attachments/assets/d6c46a9a-b2c1-41b6-b8e0-fda0fb88a7c4" />
</p>

[English](#english) | [日本語](#japanese)

<a id="english"></a>

## English

---

A face and operator companion app for coding agents.

`minimum-headroom` combines four things into one runtime: a browser face UI, a mobile-friendly operator panel, a tmux bridge for delivering operator input to your agent terminal, and MCP signaling (`face.event` / `face.say` / `face.ping`) for realtime status voice + expression feedback.

## Contents

- [At a Glance](#en-at-a-glance)
- [Quick Start](#en-quick-start)
- [Operator Bridge (Mobile Input)](#en-operator-bridge)
- [Optional Realtime ASR (vLLM + Voxtral)](#en-realtime-asr)
- [TTS Model Files](#en-tts-model-files)
- [MCP Client Config](#en-mcp-client-config)
- [Japanese](#japanese)

<a id="en-at-a-glance"></a>
## At a Glance

- Run your coding agent in tmux, and control/assist it from terminal or mobile browser.
- Use three input paths: direct terminal text, frontend PTT (JA/EN -> ASR), or frontend text fallback.
- Send approved input to the agent pane via `operator-bridge` (`tmux send-keys`).
- Mirror terminal output back to mobile/desktop UI at 500ms change-only snapshots.
- Broadcast agent state to users through MCP events/speech and browser face animation + audio.
- Access remotely from phone/tablet via Tailscale Serve.

## Features

- Operator input pipeline:
  - terminal direct prompt, frontend PTT (JA/EN), and frontend text fallback
  - browser audio -> ASR proxy -> Parakeet ASR -> append to text fallback -> tmux send
  - key controls (`Esc`, `↑`, `Select`, `↓`) and restart/recovery support
- Terminal mirror:
  - read-only tmux tail snapshots
  - 500ms publish interval (change-only)
- MCP tools for signaling:
  - `face.event` / `face.say` / `face.ping`
- Browser 3D face renderer with state-driven animation:
  - eyebrow/eye/mouth/head movement
  - state modes (`confused`, `frustration`, `confidence`, `urgency`, `stuckness`, `neutral`)
  - direct head drag control (mouse/finger) with mode-coupled expression amplification
  - panel toggle shortcuts (`Esc`, double tap, double click)
- Looking Glass WebXR support path
- TTS pipeline:
  - Kokoro ONNX + Misaki (`af_heart`) by default
  - optional experimental Qwen3-TTS Japanese backend
  - freshness-first speech policy (`interrupt`, TTL, generation invalidation)
  - speech result feedback (`say_result`)
  - selectable output route (`local`, `browser`, `both`)

## System Flow Diagrams

Static exports: [High-Level Flow PNG](doc/diagrams/high-level-flow.png), [Sequence Timeline PNG](doc/diagrams/sequence-timeline.png), [High-Level Flow SVG](doc/diagrams/high-level-flow.svg), [Sequence Timeline SVG](doc/diagrams/sequence-timeline.svg)

### High-Level Flow

```mermaid
flowchart LR
  U[User]
  TMUX[tmux Terminal<br/>Codex pane]
  C[GPT-5.3 Codex]
  MCP[MCP Server<br/>face_event / face_say / face_ping]
  WS[face-app<br/>WebSocket + HTTP :8765]
  FE[Frontend UI<br/>Browser]
  BR[operator-bridge]
  ASRP[/POST /api/operator/asr/]
  ASR[asr-worker<br/>Parakeet ASR<br/>JA/EN]
  TTS[tts-worker<br/>Kokoro TTS]
  TS[Tailscale VPN / serve]

  U -- Direct prompt --> TMUX
  U -- PTT recording --> FE
  U -- Text input --> FE

  FE -- Audio binary --> ASRP
  ASRP -- JSON (audioBase64,mimeType,lang) --> ASR
  ASR -- JSON transcript --> ASRP
  ASRP -- Transcript --> FE

  FE -- operator_response JSON --> WS
  WS -- relay --> BR
  BR -- tmux send-keys --> TMUX
  TMUX --> C
  C -- Work logs / results --> TMUX

  BR -- capture-pane (500ms, change-only) --> BR
  BR -- operator_terminal_snapshot --> WS
  WS --> FE

  C -- stdio tool calls --> MCP
  MCP -- WebSocket JSON --> WS
  WS --> FE

  WS -- say payload --> TTS
  TTS -- audio + tts state --> FE

  FE <-- HTTPS/WS --> TS
  TS <---> WS
```

### Sequence Timeline

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant TS as Tailscale (optional)
  participant FE as Frontend UI
  participant FA as face-app (:8765, /ws, /api/operator/asr)
  participant ASR as asr-worker (Parakeet)
  participant BR as operator-bridge
  participant TM as tmux (Codex pane)
  participant CX as GPT-5.3 Codex
  participant MCP as mcp-server
  participant TTS as tts-worker (Kokoro)

  opt Remote access
    U->>TS: Open Face UI URL
    TS->>FE: Serve forwarded UI
  end

  FE->>FA: Connect WebSocket /ws
  BR->>FA: Connect WebSocket /ws

  alt Input path A: direct terminal prompt
    U->>TM: Type prompt
    TM->>CX: Prompt arrives
  else Input path B: frontend PTT
    U->>FE: Hold PTT JA/EN
    FE->>FA: POST /api/operator/asr?lang=ja|en (audio)
    FA->>ASR: /v1/asr/ja|en (audioBase64,mimeType)
    ASR-->>FA: Transcript JSON
    FA-->>FE: Transcript response
    U->>FE: Tap Send
    FE->>FA: operator_response{text}
    FA-->>BR: Relay payload
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: Prompt arrives
  else Input path C: frontend text
    U->>FE: Enter text + Send Text
    FE->>FA: operator_response{text}
    FA-->>BR: Relay payload
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: Prompt arrives
  end

  loop During work
    CX-->>TM: Progress/result logs
    BR->>TM: capture-pane -e (500ms)
    BR-->>FA: operator_terminal_snapshot
    FA-->>FE: Terminal mirror update
  end

  CX->>MCP: face_event / face_say / face_ping
  MCP->>FA: Forward WebSocket JSON
  FA-->>FE: event/say/state payloads

  FA->>TTS: TTS request
  TTS-->>FA: tts_audio / tts_mouth / say_result
  FA-->>FE: Realtime status + audio
  FE-->>U: Voice, facial state, and status updates
```

## Requirements

- Node.js 20+ (Node 24 recommended)
- `uv` (for Python worker dependencies)
- Python 3.10+
- `ffmpeg` (recommended; used by ASR worker fallback decode for webm/ogg/mp4)
- Optional for audible TTS on Linux:
  - either PortAudio (`libportaudio2`) for `sounddevice`
  - or ALSA `aplay` fallback

<a id="en-quick-start"></a>
## Quick Start

Choose one startup path depending on your goal.
Before starting, configure MCP server settings for your coding agent (see [MCP Client Setup](#mcp-client-setup)), set up the agent-specific `AGENTS.md`, and reflect `doc/examples/AGENT_RULES.md` in the agent instructions.
If you plan to use the mobile UI remotely, it is also convenient to start Tailscale Serve in advance:

```bash
tailscale serve --bg 8765
```

### Path A: Face + MCP (minimal)

From repository root:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

Open the UI shown in logs (default: `http://127.0.0.1:8765/`).

In another terminal:

```bash
./scripts/run-mcp-server.sh
```

### Path B: Full Mobile Operator Stack (recommended for first-time overview)

Recommended one-shot startup (best current experience):

```bash
./scripts/run-operator-once.sh --profile qwen3-realtime
```

This script automatically:

- creates or reuses tmux session `agent` (override with `--session`)
- creates a dedicated window `operator` (auto-suffixed if name exists; override with `--window`)
- splits two panes in that window:
  - pane 0: your agent command (default `codex`, override `--agent-cmd`; starts in the shell directory where you invoked this script, or the explicit path from `--repo` / `--agent-cwd`)
  - pane 1: integrated operator stack (default `./scripts/run-operator-stack.sh`, override `--stack-cmd`)
- resolves the real agent pane id and injects it as `MH_BRIDGE_TMUX_PANE` for the stack

If you mainly use a different agent, you can also change the default launcher by editing `AGENT_CMD="codex"` in `scripts/run-operator-once.sh`.
Using `--agent-shell` is shorthand for `--agent-cmd 'bash -l'`, so you can inspect the repo first and then launch any agent manually.

Built-in startup profiles keep common combinations short:

- `default`: Codex + default operator stack (legacy-compatible baseline)
- `realtime`: default TTS + built-in Voxtral realtime ASR + Parakeet fallback
- `qwen3`: Qwen3 TTS + default operator stack
- `qwen3-realtime`: Qwen3 TTS + built-in Voxtral realtime ASR + Parakeet fallback (recommended)

If you want the lighter historical behavior, use `--profile default` or simply omit `--profile`.

Common examples:

```bash
# start from another repo with a shell only, then launch any agent manually
./scripts/run-operator-once.sh --profile qwen3-realtime --repo ~/github/other-project --agent-shell

# resume existing Codex conversation
./scripts/run-operator-once.sh --agent-cmd 'codex resume --last'

# shorter one-shot startup with built-in Voxtral realtime ASR + Parakeet fallback
./scripts/run-operator-once.sh --profile realtime

# Qwen3 TTS + Voxtral realtime ASR in one command
./scripts/run-operator-once.sh --profile qwen3-realtime

# start with a shell in the current project, then launch any agent manually
./scripts/run-operator-once.sh --agent-shell

# custom tmux names + mobile browser audio
./scripts/run-operator-once.sh --session work --window mobile --ui-mode mobile --audio-target browser

# fully custom stack command still works for advanced overrides
./scripts/run-operator-once.sh --stack-cmd 'TTS_ENGINE=qwen3 MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 ./scripts/run-operator-stack.sh'

# start and keep current shell (no tmux attach/switch)
./scripts/run-operator-once.sh --no-attach
```

Manual startup (equivalent) if you prefer explicit steps:

1) Start tmux and launch your coding agent in one pane:

```bash
tmux new -s agent
codex
```

2) In another terminal, launch the integrated stack:

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

This starts `asr-worker`, `face-app`, and `operator-bridge` together with mobile-oriented UI defaults.

You can also use npm scripts for Path A:

```bash
npm run face-app:start
npm run mcp-server:start
```

### Audio Output Target

`./scripts/run-face-app.sh` supports selecting where speech is heard:

```bash
# default (host speaker only)
./scripts/run-face-app.sh --audio-target local

# browser clients only (useful for iOS over tailscale serve)
./scripts/run-face-app.sh --audio-target browser

# both host speaker and browser clients
./scripts/run-face-app.sh --audio-target both
```

`./scripts/run-face-app.sh` also supports UI layout mode:

```bash
# auto detect (default)
./scripts/run-face-app.sh --ui-mode auto

# desktop-oriented debug layout
./scripts/run-face-app.sh --ui-mode pc

# mobile operator layout (full-screen operator panel)
./scripts/run-face-app.sh --ui-mode mobile
```

Tip: when using `--audio-target browser` or `--audio-target both`, you can run:

```bash
tailscale serve --bg 8765
```

Then open the Tailscale Serve URL from your phone/tablet to use the Face App remotely (it forwards to this host's `localhost:8765`).

When using iOS Safari, the first tap/click unlocks browser audio. If autoplay is blocked, use the in-page `Tap to enable audio` button to replay the latest utterance.

### Face Interaction Controls

- Drag on the face/canvas area with mouse or finger to steer head direction.
- While dragging, the active mood is amplified:
  - `confidence` becomes more confident.
  - negative modes (`confused`, `frustration`, `stuckness`) become more pronounced.
- Panel visibility shortcuts remain:
  - `Esc` (desktop keyboard)
  - double tap (mobile)
  - double click (desktop)

<a id="en-operator-bridge"></a>
## Operator Bridge (Mobile Input)

### tmux Setup (From Zero)

```bash
# 1) start tmux and launch your coding agent in one pane
tmux new -s agent
codex
```

In another terminal (or another tmux pane), confirm target pane id:

```bash
tmux display-message -p '#S:#I.#P'
```

Example output: `agent:0.0`

### One-Command Operator Stack

Run the integrated stack:

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

This starts:

- `asr-worker` (Parakeet ASR)
- `face-app`
- `operator-bridge`

Default stack UI mode is mobile (`FACE_UI_MODE=mobile`) so iPhone/iPad operator UI is immediately usable.  
Override if needed:

```bash
FACE_UI_MODE=pc MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

By default this does **not** start `mcp-server` because MCP stdio is usually managed by your agent process (for example Codex CLI).

If you explicitly want stack-managed MCP startup:

```bash
MH_STACK_START_MCP=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

If you run inside tmux, `MH_BRIDGE_TMUX_PANE` can be omitted because `TMUX_PANE` is used automatically.

### ASR Worker (Parakeet) Setup

`./scripts/setup.sh` now syncs both Python workers:

```bash
uv sync --project tts-worker
uv sync --project asr-worker --locked
```

Optional setup entrypoints:

- `npm run setup` -> base setup only
- `npm run setup:all` -> base setup plus optional realtime ASR tooling (recommended if you want Voxtral realtime ASR)
- `npm run setup:realtime-asr` -> install only the optional vLLM + Voxtral realtime ASR environment

Run ASR worker alone:

```bash
./scripts/run-asr-worker.sh
```

Default device policy:

- Linux: `ASR_DEVICE=cuda` (default)
- macOS / CPU-only hosts: auto-fallback to `ASR_DEVICE=cpu` in `run-asr-worker.sh` when unset
- explicit override is always allowed:

```bash
ASR_DEVICE=cpu ./scripts/run-asr-worker.sh
```

Parakeet model defaults:

- EN: `nvidia/parakeet-tdt-0.6b-v2`
- JA: `nvidia/parakeet-tdt_ctc-0.6b-ja`

The first run downloads models via Hugging Face cache (`~/.cache/huggingface/hub`).  
If you already used `../english-trainer`, the same cache is reused; model file copy is usually unnecessary.

<a id="en-realtime-asr"></a>
### Optional Realtime ASR (vLLM + Voxtral)

Install the optional realtime ASR environment:

```bash
./scripts/setup-realtime-asr.sh
```

This creates a dedicated vLLM virtualenv at `./.venv-vllm` and installs a nightly `vllm` build (default backend: `cu130`) plus the audio/tokenizer helper packages needed for Voxtral. If you already ran `npm run setup:all`, you can skip this step.

Run the local vLLM realtime server:

```bash
./scripts/run-vllm-voxtral.sh
```

Default runtime behavior:

- bind address: `127.0.0.1:8090`
- realtime websocket: `ws://127.0.0.1:8090/v1/realtime`
- model cache: `./.cache/huggingface/`
- vLLM config cache: `./.cache/vllm/`
- model: `mistralai/Voxtral-Mini-4B-Realtime-2602`
- `gpu_memory_utilization`: `0.88` by default to leave more headroom when the desktop or other CUDA processes are active

#### Recommended Startup Modes

1. Parakeet only (lowest VRAM, no realtime)

   Install:

   ```bash
   npm run setup
   ```

   Start:

   ```bash
   MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   Use this on smaller GPUs, or if you only want the classic batch ASR flow.

2. Voxtral realtime + Parakeet fallback (best UX, higher VRAM)

   Install:

   ```bash
   npm run setup:all
   ```

   Start:

   ```bash
   MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   This starts the local vLLM realtime server inside the integrated stack and keeps batch `/api/operator/asr` fallback enabled. On one 32GB Blackwell test host, this combined mode used about `22 GiB` of VRAM.

3. Voxtral realtime only (lower VRAM than hybrid)

   Install:

   ```bash
   npm run setup:all
   ```

   Start:

   ```bash
   MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_STACK_SKIP_ASR=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   This keeps realtime ASR active but disables batch `/api/operator/asr` fallback inside the integrated stack. Use this if VRAM is tight and you can live without the Parakeet fallback path.

If you already started `./scripts/run-vllm-voxtral.sh` in another terminal, point the stack at that existing server instead of starting a second copy:

```bash
MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

For very short utterances (currently under about `0.25s`), the UI now skips batch fallback and shows a `speech too short to transcribe` warning instead of surfacing an ASR error. Longer realtime-empty utterances still show an explicit warning, and if batch ASR is still available they automatically retry once through the existing `/api/operator/asr` path.

PTT recording also auto-stops at about `30s` per utterance, then finalizes that segment. Longer dictation should be spoken in multiple segments.

### Operator Bridge Details

`run-operator-bridge.sh` targets one tmux pane.

- If launched inside tmux, it uses `$TMUX_PANE`.
- Or set it explicitly: `MH_BRIDGE_TMUX_PANE=<pane-id-or-target>`.

Default bridge behavior:

- read-only terminal mirror tail: `200` lines
- mirror publish interval: `500ms` (change-only publish)
- restart command: `codex resume --last` (with pre-key `C-u`)

You can override with environment variables:

- `MH_BRIDGE_WS_URL` (default: `ws://127.0.0.1:8765/ws`)
- `MH_BRIDGE_SESSION_ID` (default: `default`)
- `MH_BRIDGE_TMUX_PANE` (required unless running inside tmux)
- `MH_BRIDGE_RESTART_COMMAND` / `MH_BRIDGE_RESTART_PRE_KEYS`
- `MH_BRIDGE_MIRROR_LINES` / `MH_BRIDGE_MIRROR_INTERVAL_MS`
- `MH_BRIDGE_SUBMIT_REINFORCE_DELAY_MS` (default: `90`; manual no-request text/choice send adds a second Enter after this delay)

### Operator UI Controls

- `Esc` button is always visible and sends Escape key semantics to tmux.
- `Restart` is shown only for recovery/offline conditions.
- Arrow key controls are always available as on-screen buttons: `↑`, `Select`, `↓`.
- The operator panel is intentionally always open in current mobile-focused behavior.
- `operator-handle` / `close panel` controls are currently hidden in UI.
- UI mode behavior:
  - `pc`: debug panels remain visible and operator panel is available in the same page.
  - `mobile`: near full-screen translucent operator panel, terminal mirror always visible.
- `PTT JA` / `PTT EN` records audio, then appends text into the text fallback input. By default this is batch ASR; an experimental realtime mode can stream incremental text while you are still speaking.
- Text fallback input is always available in operator panel and can be used even when no explicit `operator_prompt` is active.
- Text fallback row actions:
  - `Send Text`: submit current text input to tmux/Codex.
  - `Clear`: clear only the text field contents.
  - `Hide KB`: blur the text box (mobile keyboard close) without clearing the current draft.
- `Esc` also blurs text input focus before sending Escape key semantics.
- Terminal mirror is read-only.

### ASR Proxy Endpoint

Browser PTT audio is posted to `face-app` at:

```text
POST /api/operator/asr?lang=ja|en
```

`face-app` converts binary audio to ASR-worker JSON (`audioBase64`, `mimeType`) and forwards it to:

- `ja` -> `${MH_OPERATOR_ASR_BASE_URL}/v1/asr/ja`
- `en` -> `${MH_OPERATOR_ASR_BASE_URL}/v1/asr/en`

ASR-related env vars:

- `MH_OPERATOR_ASR_BASE_URL` (default: `http://127.0.0.1:8091`)
- `MH_OPERATOR_ASR_ENDPOINT_URL` (optional explicit endpoint override)
- `MH_OPERATOR_ASR_TIMEOUT_MS` (default: `20000`)
- `MH_OPERATOR_ASR_MODEL_JA` / `MH_OPERATOR_ASR_MODEL_EN` (optional upstream model override)

Experimental realtime ASR (disabled by default):

- `MH_OPERATOR_REALTIME_ASR_ENABLED=1` enables the browser websocket streaming path.
- `MH_OPERATOR_REALTIME_ASR_WS_URL` points `face-app` at a vLLM realtime websocket (default stack example: `ws://127.0.0.1:8090/v1/realtime`).
- `MH_OPERATOR_REALTIME_ASR_MODEL` overrides the upstream realtime model name (default: `mistralai/Voxtral-Mini-4B-Realtime-2602`).
- `MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ` controls the browser-side PCM16 target sample rate (default: `16000`).
- `MH_STACK_START_REALTIME_ASR=1` starts `./scripts/run-vllm-voxtral.sh` inside `run-operator-stack.sh` and also forces realtime mode on.
- `REALTIME_ASR_GPU_MEMORY_UTILIZATION` sets vLLM `--gpu-memory-utilization` (default: `0.88`).
- `MH_STACK_SKIP_ASR=1` skips launching the batch `asr-worker` inside `run-operator-stack.sh` to reduce VRAM use.
  - When this is used with the default local ASR target and no explicit `MH_OPERATOR_ASR_ENDPOINT_URL`, `run-operator-stack.sh` also disables the local batch ASR proxy so realtime empty-result fallback does not point at a dead `8091` endpoint.

When realtime mode is enabled, `PTT JA` / `PTT EN` streams PCM16 audio chunks over the existing `face-app` websocket and incremental text appears in the existing text fallback input before release. If realtime mode is disabled, unavailable, or the browser lacks the required audio APIs, the existing batch `MediaRecorder -> /api/operator/asr -> asr-worker` flow remains active.

### iOS / Tailscale Runbook

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
tailscale serve --bg 8765
```

Then open the Tailscale Serve URL from iPhone/iPad.

Troubleshooting quick checks:

- No PTT transcript:
  - check ASR worker health: `curl -sS http://127.0.0.1:8091/health`
  - check `run-operator-stack.sh` logs for `asr_upstream_not_configured` / timeout
- Realtime ASR not connecting:
  - check vLLM server models: `curl -sS http://127.0.0.1:8090/v1/models`
  - confirm `MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime`
  - if vLLM reports low free GPU memory, lower `REALTIME_ASR_GPU_MEMORY_UTILIZATION` (for example `0.85`) or use `MH_STACK_SKIP_ASR=1`
- Bridge input not reaching agent:
  - verify pane id: `tmux display-message -p '#S:#I.#P'`
  - ensure `MH_BRIDGE_TMUX_PANE` matches the pane running `codex`
- Need to abort current agent action:
  - use always-visible `Esc` in operator UI
- Panel seems missing after custom CSS/UI edits:
  - confirm `FACE_UI_MODE=mobile|pc` and reload the page

<a id="en-tts-model-files"></a>
## TTS Model Files (Kokoro only)

Place model files in `assets/kokoro/`:

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

Reference download instructions are in `assets/kokoro/README.md`.

These large model files are intentionally ignored by git.

Optional experimental Qwen3-TTS setup:

```bash
./scripts/setup-qwen3-tts.sh
```

This creates a dedicated local virtualenv at `./.venv-qwen-tts` and installs `qwen-tts` there so the default Kokoro path can stay lightweight.
If `flash-attn` is not installed, Qwen3-TTS still works on the current path; it simply falls back to the manual PyTorch implementation and may run slower.

To use the optional backend:

```bash
TTS_ENGINE=qwen3 ./scripts/run-tts-worker.sh --smoke
TTS_ENGINE=qwen3 ./scripts/run-face-app.sh
```

### Qwen3 Speech Behavior

The Qwen3 backend does not use Kokoro's ASCII-versus-non-ASCII language split. It reads the whole utterance through one configured voice and one configured language profile.

Current defaults for the experimental Qwen3 path:

- `MH_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `MH_QWEN_TTS_SPEAKER=Serena`
- `MH_QWEN_TTS_LANGUAGE=English`
- `MH_QWEN_JA_ASCII_MODE=preserve`
- `MH_QWEN_TTS_STYLE=neutral`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.10`

The current experimental default is based on listening tests with mixed Japanese and English text. It keeps one Qwen3 voice across the whole utterance instead of using Kokoro's current ASCII-versus-non-ASCII language split.
With the current `English` profile, if a speech-only utterance begins with a CJK ideograph (for example a kanji-led Japanese sentence), the Qwen3 path now prepends `はい、` internally for audio generation only. This helps stabilize the first word without changing the visible text.
If the chosen Qwen3 voice sounds too quiet or too strong, adjust `MH_QWEN_TTS_GAIN` (for example `1.0`, `1.25`, or `1.50`). Peaks above unity are scaled back automatically to avoid hard clipping.
If it still feels slightly slow, adjust `MH_QWEN_TTS_SPEED` (for example `1.0`, `1.10`, or `1.20`). Values above `1.0` speak faster.

## Speech Gate Config (`config.yaml`)

`face-app` now reads `config.yaml` from repository root at startup (or `FACE_CONFIG_PATH` if set) and applies `speech_gate` values to voice throttling.

Checked-in defaults are intentionally relaxed so the assistant can speak more often:

```yaml
speech_gate:
  min_interval_priority1_ms: 1500
  global_window_ms: 60000
  global_limit_low_priority: 24
  session_window_ms: 60000
  session_limit_low_priority: 12
  dedupe_ms_low_priority: 800
```

Fields map to runtime gate options:

- `min_interval_priority1_ms` -> minimum interval for `priority=1`
- `global_limit_low_priority` within `global_window_ms` for `priority<=2`
- `session_limit_low_priority` within `session_window_ms` for `priority<=2`
- `dedupe_ms_low_priority` for repeated `dedupe_key` on `priority<=2`

## Long Speech Behavior

- `face.say` default `ttl_ms` is now `60000` (60s) when omitted.
- You can override default with env var `FACE_SAY_DEFAULT_TTL_MS` on `mcp-server`.
- `face-app` also supports `tts.default_ttl_ms` in `config.yaml`.
- `face-app` supports `tts.auto_interrupt_after_ms`: when `policy=replace` input arrives after this threshold while another speech is active, it is promoted to interrupt.

When a new `face.say` arrives during playback:

- `policy=replace` keeps current playback and queues only the latest pending utterance.
- `policy=interrupt` (or `priority=3`) stops current playback and starts the new utterance immediately.

## Speech Language Routing (Kokoro only)

- ASCII text is spoken as English (`en-us`, speed `1.0`)
- Non-ASCII text is spoken as Japanese (`j`, speed `1.2`)

### English Normalization Spec

Applied to all `face.say` text before speech synthesis, regardless of whether the active backend is Kokoro or Qwen3. Only the language-routing rules above are Kokoro-specific.

- `‘` / `’` -> `'`
- `“` / `”` -> `"`
- `…` / `...` -> regular space
- `。` / `、` / `・` -> regular space
- NBSP (`U+00A0`) / NNBSP (`U+202F`) -> regular space
- Latin letters with combining marks are ASCII-normalized
  - `café -> cafe`, `naïve -> naive`, `rôle -> role`
- Existing inline dash normalization is preserved for English
  - `9-to-5 -> 9 to 5`
- Full-width symbols/letters and Japanese characters are preserved
- If normalization results in empty text, speech is skipped

This is implemented in the face-app TTS controller (common normalization) plus the backend-specific tts-worker synthesis path. Kokoro additionally applies the language routing described above.

<a id="en-mcp-client-config"></a>
## MCP Client Config

Do not commit your personal local config files.

### Codex CLI example

Use `doc/examples/codex/config.toml` as a template. Update absolute paths for your machine.

If your MCP client rejects tool names with dots (for example `face.event`), set:

```toml
env = { FACE_WS_URL = "ws://127.0.0.1:8765/ws", MCP_TOOL_NAME_STYLE = "underscore" }
```

Then tools are published as:

- `face_event`
- `face_say`
- `face_ping`

### Antigravity example

Use `doc/examples/antigravity/mcp_config.json` as a template with your own absolute path.

For agent-side signaling conventions, see `doc/examples/AGENT_RULES.md`.

## Optional Agent Skills

This repository includes reusable skill packages under `doc/examples/skills/`:

- `release-ci-flow`
- `minimum-headroom-ops`
- `looking-glass-webxr-setup`

Each folder contains a `SKILL.md` and can be copied into your local skills directory (for example `$CODEX_HOME/skills/`) if your agent supports local skill loading.

## Release Checklist

- Run tests:

```bash
npm test
```

- Verify MCP startup:

```bash
./scripts/run-mcp-server.sh
```

- Verify face app startup and browser rendering:

```bash
./scripts/run-face-app.sh
```

- Verify TTS worker smoke:

```bash
npm run tts-worker:smoke
```

- Verify ASR worker smoke:

```bash
npm run asr-worker:smoke
```

- Verify operator stack startup (inside tmux or with `MH_BRIDGE_TMUX_PANE` set):

```bash
./scripts/run-operator-stack.sh
```

## Repository Notes

- Runtime/local files (models, local MCP config, caches, venv) are excluded via `.gitignore`.

<a id="japanese"></a>

## 日本語

コーディングエージェント向けのフェイス・オペレーター支援アプリです。

`minimum-headroom` は次の4つを1つの実行環境としてまとめたアプリです。

- ブラウザで動作するフェイスUI
- モバイル向けオペレーターパネル
- オペレーター入力をエージェント用tmuxペインへ届ける `operator-bridge`
- MCPシグナリング (`face.event` / `face.say` / `face.ping`) によるリアルタイム状態通知（音声・表情）

## 目次

- [全体像（要点）](#ja-overview)
- [クイックスタート](#ja-quick-start)
- [Operator Bridge（モバイル入力）](#ja-operator-bridge)
- [任意のRealtime ASR（vLLM + Voxtral）](#ja-realtime-asr)
- [TTS モデルファイル](#ja-tts-model-files)
- [MCPクライアント設定](#ja-mcp-client-config)
- [English](#english)

<a id="ja-overview"></a>
## 全体像（要点）

- エージェントを tmux で動かし、端末またはモバイルブラウザから補助操作できます。
- 入力経路は3つです: 端末の直接入力、フロントエンドPTT（JA/EN -> ASR）、フロントエンドのテキスト入力。
- 承認・送信された入力は `operator-bridge` が `tmux send-keys` でエージェントペインへ投入します。
- 端末出力は 500ms 間隔（差分があるときのみ）でミラー配信されます。
- エージェント状態は MCP イベント/発話とフェイスUI（表情・音声）でユーザーへ通知されます。
- Tailscale Serve を使うとスマホ/タブレットからリモートアクセスできます。

## 機能

- オペレーター入力パイプライン:
  - 端末直接入力 / フロントエンドPTT（JA/EN）/ フロントエンドテキスト入力
  - ブラウザ音声 -> ASRプロキシ -> Parakeet ASR -> テキスト入力へ追記 -> tmux送信
  - キー操作（`Esc`, `↑`, `Select`, `↓`）と復旧用 `Restart`
- ターミナルミラー:
  - tmux末尾出力の読み取り専用スナップショット
  - 500ms 発行（変更があった場合のみ）
- MCPシグナリングツール:
  - `face.event` / `face.say` / `face.ping`
- ブラウザ3Dフェイス描画:
  - 眉・目・口・頭の状態駆動アニメーション
  - 状態モード（`confused`, `frustration`, `confidence`, `urgency`, `stuckness`, `neutral`）
  - ドラッグ操作（マウス/タッチ）による頭部制御とモード連動バイアス
  - パネル表示切替ショートカット（`Esc`, ダブルタップ, ダブルクリック）
- Looking Glass WebXR 対応経路
- TTSパイプライン:
  - 既定は Kokoro ONNX + Misaki (`af_heart`)
  - 任意で実験的な Qwen3-TTS 日本語 backend
  - 発話鮮度優先ポリシー（`interrupt`, TTL, generation）
  - `say_result` フィードバック
  - 出力先切替（`local`, `browser`, `both`）

## システムフロー図

静的エクスポート: [High-Level Flow PNG](doc/diagrams/high-level-flow.png), [Sequence Timeline PNG](doc/diagrams/sequence-timeline.png), [High-Level Flow SVG](doc/diagrams/high-level-flow.svg), [Sequence Timeline SVG](doc/diagrams/sequence-timeline.svg)

### ハイレベルフロー

```mermaid
flowchart LR
  U[ユーザー]
  TMUX[tmux ターミナル<br/>Codex ペイン]
  C[GPT-5.3 Codex]
  MCP[MCP サーバー<br/>face_event / face_say / face_ping]
  WS[face-app<br/>WebSocket + HTTP :8765]
  FE[フロントエンド UI<br/>ブラウザ]
  BR[operator-bridge]
  ASRP[/POST /api/operator/asr/]
  ASR[asr-worker<br/>Parakeet ASR<br/>JA/EN]
  TTS[tts-worker<br/>Kokoro TTS]
  TS[Tailscale VPN / serve]

  U -- 直接プロンプト --> TMUX
  U -- PTT録音 --> FE
  U -- テキスト入力 --> FE

  FE -- 音声バイナリ --> ASRP
  ASRP -- JSON (audioBase64,mimeType,lang) --> ASR
  ASR -- 文字起こしJSON --> ASRP
  ASRP -- 文字起こし結果 --> FE

  FE -- operator_response JSON --> WS
  WS -- relay --> BR
  BR -- tmux send-keys --> TMUX
  TMUX --> C
  C -- 作業ログ / 結果 --> TMUX

  BR -- capture-pane (500ms, change-only) --> BR
  BR -- operator_terminal_snapshot --> WS
  WS --> FE

  C -- stdio tool calls --> MCP
  MCP -- WebSocket JSON --> WS
  WS --> FE

  WS -- say payload --> TTS
  TTS -- audio + tts state --> FE

  FE <-- HTTPS/WS --> TS
  TS <---> WS
```

### 時系列シーケンス

```mermaid
sequenceDiagram
  autonumber
  participant U as ユーザー
  participant TS as Tailscale (任意)
  participant FE as Frontend UI
  participant FA as face-app (:8765, /ws, /api/operator/asr)
  participant ASR as asr-worker (Parakeet)
  participant BR as operator-bridge
  participant TM as tmux (Codex pane)
  participant CX as GPT-5.3 Codex
  participant MCP as mcp-server
  participant TTS as tts-worker (Kokoro)

  opt リモートアクセス
    U->>TS: Face UI URLを開く
    TS->>FE: 転送されたUIを表示
  end

  FE->>FA: WebSocket /ws 接続
  BR->>FA: WebSocket /ws 接続

  alt 入力経路A: 端末直接入力
    U->>TM: プロンプトを入力
    TM->>CX: プロンプト到達
  else 入力経路B: フロントエンドPTT
    U->>FE: PTT JA/EN を押下
    FE->>FA: POST /api/operator/asr?lang=ja|en (audio)
    FA->>ASR: /v1/asr/ja|en (audioBase64,mimeType)
    ASR-->>FA: 文字起こしJSON
    FA-->>FE: 文字起こし結果
    U->>FE: Send を押下
    FE->>FA: operator_response{text}
    FA-->>BR: payload relay
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: プロンプト到達
  else 入力経路C: フロントエンドテキスト
    U->>FE: テキスト入力 + Send Text
    FE->>FA: operator_response{text}
    FA-->>BR: payload relay
    BR->>TM: tmux send-keys(text + Enter)
    TM->>CX: プロンプト到達
  end

  loop 作業中
    CX-->>TM: 進捗/結果ログ
    BR->>TM: capture-pane -e (500ms)
    BR-->>FA: operator_terminal_snapshot
    FA-->>FE: ターミナルミラー更新
  end

  CX->>MCP: face_event / face_say / face_ping
  MCP->>FA: WebSocket JSON転送
  FA-->>FE: event/say/state payloads

  FA->>TTS: TTS request
  TTS-->>FA: tts_audio / tts_mouth / say_result
  FA-->>FE: リアルタイム状態 + 音声
  FE-->>U: 音声・表情・状態を表示
```

## 必要環境

- Node.js 20+（Node 24 推奨）
- `uv`（Python worker依存管理）
- Python 3.10+
- `ffmpeg`（推奨。ASR worker の webm/ogg/mp4 フォールバックデコードに使用）
- Linuxで音声出力する場合（任意）:
  - PortAudio (`libportaudio2`) + `sounddevice`
  - または ALSA `aplay`

<a id="ja-quick-start"></a>
## クイックスタート

目的に合わせて起動パスを選んでください。
開始前に、利用するコーディングエージェントで MCP サーバー設定を行い（[MCPクライアント設定](#mcpクライアント設定) を参照）、エージェント向け `AGENTS.md` を設定し、`doc/examples/AGENT_RULES.md` の内容をエージェント指示へ反映してください。
モバイルUIをリモート利用する場合は、先に Tailscale Serve を起動しておくと便利です。

```bash
tailscale serve --bg 8765
```

### Path A: Face + MCP（最小構成）

リポジトリルートで実行:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

ログに表示されるURL（既定: `http://127.0.0.1:8765/`）を開きます。

別ターミナルで:

```bash
./scripts/run-mcp-server.sh
```

### Path B: フルモバイル Operator Stack（初見ユーザー推奨）

推奨: 1発起動スクリプト（いまのおすすめ構成）

```bash
./scripts/run-operator-once.sh --profile qwen3-realtime
```

このスクリプトは自動で次を行います:

- tmux セッション `agent` を作成または再利用（`--session` で変更可）
- 専用ウィンドウ `operator` を作成（同名があれば `operator-1` のように自動採番、`--window` で変更可）
- 2ペインへ分割:
  - 0番ペイン: エージェント起動コマンド（既定 `codex`、`--agent-cmd` で変更。絶対パスでこのスクリプトを呼んでも、呼び出したシェルのカレントディレクトリ、または `--repo` / `--agent-cwd` で指定した場所で開始）
  - 1番ペイン: 統合スタック起動（既定 `./scripts/run-operator-stack.sh`、`--stack-cmd` で変更）
- 実際のエージェントペインIDを解決し、`MH_BRIDGE_TMUX_PANE` として統合スタックへ自動注入

別のエージェントを常用するなら、`scripts/run-operator-once.sh` 内の `AGENT_CMD="codex"` を変更して既定値を差し替えられます。
`--agent-shell` は `--agent-cmd 'bash -l'` の短縮なので、対象プロジェクトでログインシェルに戻ってから、内容を確認して好きなエージェントを手動で起動できます。

よく使う起動プロファイル:

- `default`: Codex + 既定の operator stack（従来互換の軽量ベース）
- `realtime`: 既定TTS + 内蔵 Voxtral realtime ASR + Parakeet fallback
- `qwen3`: Qwen3 TTS + 既定の operator stack
- `qwen3-realtime`: Qwen3 TTS + 内蔵 Voxtral realtime ASR + Parakeet fallback（推奨）

従来どおりの軽い起動にしたい場合は、`--profile default` を使うか、`--profile` を省略してください。

よく使う例:

```bash
# 別リポジトリを作業対象にし、まずシェルだけ開く
./scripts/run-operator-once.sh --profile qwen3-realtime --repo ~/github/other-project --agent-shell

# 直前セッションを再開
./scripts/run-operator-once.sh --agent-cmd 'codex resume --last'

# Voxtral realtime ASR + Parakeet fallback を短く1発起動
./scripts/run-operator-once.sh --profile realtime

# Qwen3 TTS + Voxtral realtime ASR を1発起動
./scripts/run-operator-once.sh --profile qwen3-realtime

# 今いるプロジェクトでシェルを開き、好きなエージェントを手動起動
./scripts/run-operator-once.sh --agent-shell

# tmux名を変更 + モバイル向けブラウザ音声
./scripts/run-operator-once.sh --session work --window mobile --ui-mode mobile --audio-target browser

# 高度な上書きが必要なら --stack-cmd もそのまま使える
./scripts/run-operator-once.sh --stack-cmd 'TTS_ENGINE=qwen3 MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 ./scripts/run-operator-stack.sh'

# 起動のみ行い、現在のシェルを維持（attach/switchしない）
./scripts/run-operator-once.sh --no-attach
```

手動で分けて起動したい場合（同等手順）:

1) tmuxを起動し、1ペインでエージェントを起動:

```bash
tmux new -s agent
codex
```

2) 別ターミナルで統合スタックを起動:

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

このコマンドで `asr-worker` / `face-app` / `operator-bridge` がまとめて起動します（モバイル向けUI前提）。

Path A は npm scripts でも起動できます:

```bash
npm run face-app:start
npm run mcp-server:start
```

### 音声出力先（Audio Output Target）

`./scripts/run-face-app.sh` で音声出力先を選択できます。

```bash
# 既定（ホストスピーカーのみ）
./scripts/run-face-app.sh --audio-target local

# ブラウザのみ（iOS + tailscale serve運用向け）
./scripts/run-face-app.sh --audio-target browser

# ホスト + ブラウザ両方
./scripts/run-face-app.sh --audio-target both
```

`./scripts/run-face-app.sh` はUIモードも選択できます。

```bash
# 自動判定（既定）
./scripts/run-face-app.sh --ui-mode auto

# デスクトップ向け
./scripts/run-face-app.sh --ui-mode pc

# モバイル向け（ほぼ全画面のoperator panel）
./scripts/run-face-app.sh --ui-mode mobile
```

`--audio-target browser` または `both` の場合、次の設定が便利です。

```bash
tailscale serve --bg 8765
```

スマホ/タブレットから Tailscale Serve URL を開くと、このホストの `localhost:8765` に転送されます。

iOS Safari では初回タップで音声アンロックが必要です。自動再生がブロックされた場合、UI内 `Tap to enable audio` を使って直近発話を再生できます。

### フェイス操作

- 顔/キャンバス領域をドラッグ（マウス・タッチ）すると頭部向きを操作できます。
- ドラッグ中は現在の感情モードが強調されます。
  - `confidence` はより自信寄りに
  - `confused`, `frustration`, `stuckness` はより強く
- パネル表示切替ショートカット:
  - `Esc`（デスクトップ）
  - ダブルタップ（モバイル）
  - ダブルクリック（デスクトップ）

<a id="ja-operator-bridge"></a>
## Operator Bridge（モバイル入力）

### tmux セットアップ（ゼロから）

```bash
# 1) tmuxを起動し、1ペインでエージェントを起動
tmux new -s agent
codex
```

別ターミナル（または別tmuxペイン）で対象ペインIDを確認:

```bash
tmux display-message -p '#S:#I.#P'
```

例: `agent:0.0`

### 1コマンド統合起動

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

起動されるサービス:

- `asr-worker`（Parakeet ASR）
- `face-app`
- `operator-bridge`

既定では `FACE_UI_MODE=mobile` で起動するため、iPhone/iPadでそのまま使いやすい設定です。必要に応じて上書きできます。

```bash
FACE_UI_MODE=pc MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

既定では `mcp-server` は起動しません（通常はエージェント側がstdio管理するため）。

`mcp-server` も統合起動したい場合:

```bash
MH_STACK_START_MCP=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

tmux内で実行している場合は `MH_BRIDGE_TMUX_PANE` を省略できます（`TMUX_PANE` を自動使用）。

### ASR Worker（Parakeet）

`./scripts/setup.sh` は2つのPython workerを同期します。

```bash
uv sync --project tts-worker
uv sync --project asr-worker --locked
```

追加のセットアップ導線:

- `npm run setup` -> 基本セットアップのみ
- `npm run setup:all` -> 基本セットアップ + 任意のRealtime ASR環境（Voxtral realtime ASR を使うなら推奨）
- `npm run setup:realtime-asr` -> 任意の vLLM + Voxtral Realtime ASR環境のみ導入

ASR worker 単体起動:

```bash
./scripts/run-asr-worker.sh
```

既定デバイス方針:

- Linux: `ASR_DEVICE=cuda`（既定）
- macOS / CPUのみ: `run-asr-worker.sh` が未指定時に `ASR_DEVICE=cpu` へ自動フォールバック
- 明示上書きも可能:

```bash
ASR_DEVICE=cpu ./scripts/run-asr-worker.sh
```

Parakeet既定モデル:

- EN: `nvidia/parakeet-tdt-0.6b-v2`
- JA: `nvidia/parakeet-tdt_ctc-0.6b-ja`

初回実行時は Hugging Face キャッシュ（`~/.cache/huggingface/hub`）へモデルを取得します。

<a id="ja-realtime-asr"></a>
### 任意のRealtime ASR（vLLM + Voxtral）

任意のRealtime ASR環境を導入:

```bash
./scripts/setup-realtime-asr.sh
```

このスクリプトは専用の vLLM 仮想環境 `./.venv-vllm` を作成し、nightly の `vllm`（既定バックエンド: `cu130`）と、Voxtral で使う補助パッケージを導入します。すでに `npm run setup:all` を実行済みなら、この手順は省略できます。

ローカル vLLM realtime サーバ起動:

```bash
./scripts/run-vllm-voxtral.sh
```

既定値:

- バインド: `127.0.0.1:8090`
- realtime WebSocket: `ws://127.0.0.1:8090/v1/realtime`
- モデルキャッシュ: `./.cache/huggingface/`
- vLLM設定キャッシュ: `./.cache/vllm/`
- モデル: `mistralai/Voxtral-Mini-4B-Realtime-2602`
- `gpu_memory_utilization`: 既定で `0.88`（デスクトップや他のCUDAプロセスと競合しにくくするため）

#### 推奨起動モード

1. Parakeetのみ（最小VRAM、Realtimeなし）

   導入:

   ```bash
   npm run setup
   ```

   起動:

   ```bash
   MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   GPUが小さい場合や、従来の batch ASR だけで十分な場合はこれが最も簡単です。

2. Voxtral realtime + Parakeet fallback（体験優先、VRAM多め）

   導入:

   ```bash
   npm run setup:all
   ```

   起動:

   ```bash
   MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   この場合、統合スタック内で `./scripts/run-vllm-voxtral.sh` が起動し、batch `/api/operator/asr` フォールバックも維持されます。32GB の Blackwell テスト機では、この構成で約 `22 GiB` の VRAM を使用しました。

3. Voxtral realtimeのみ（ハイブリッドより省VRAM）

   導入:

   ```bash
   npm run setup:all
   ```

   起動:

   ```bash
   MH_STACK_START_REALTIME_ASR=1 MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_STACK_SKIP_ASR=1 MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
   ```

   Realtime ASR は有効のまま、統合スタック内の batch `/api/operator/asr` フォールバックを停止します。VRAM が厳しい場合はこちらが向いています。

すでに別ターミナルで `./scripts/run-vllm-voxtral.sh` を起動している場合は、2重起動せず既存サーバへ接続します:

```bash
MH_OPERATOR_REALTIME_ASR_ENABLED=1 MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
```

ごく短い発話（現在は約 `0.25` 秒未満）では、UI は batch fallback を呼ばず、`speech too short to transcribe` の warning を表示します。Realtime 経路が空文字で終わったより長い発話については、UI は明示的に warning を出し、batch ASR が利用可能なら既存の `/api/operator/asr` 経路へ1回だけ自動フォールバックします。

PTT 録音は1発話あたり約 `30` 秒で自動終了し、その時点でその区間を確定します。より長い口述は複数区間に分けて話してください。

### Operator Bridge 詳細

`run-operator-bridge.sh` は1つの tmux ペインを対象にします。

- tmux内起動時: `$TMUX_PANE` を使用
- 明示指定: `MH_BRIDGE_TMUX_PANE=<pane-id-or-target>`

既定挙動:

- ターミナルミラー末尾: `200` 行
- ミラー発行間隔: `500ms`（変更時のみ）
- 再開コマンド: `codex resume --last`（事前キー `C-u`）

上書き可能な環境変数:

- `MH_BRIDGE_WS_URL`（既定: `ws://127.0.0.1:8765/ws`）
- `MH_BRIDGE_SESSION_ID`（既定: `default`）
- `MH_BRIDGE_TMUX_PANE`（tmux外では必須）
- `MH_BRIDGE_RESTART_COMMAND` / `MH_BRIDGE_RESTART_PRE_KEYS`
- `MH_BRIDGE_MIRROR_LINES` / `MH_BRIDGE_MIRROR_INTERVAL_MS`
- `MH_BRIDGE_SUBMIT_REINFORCE_DELAY_MS`（既定: `90`）

### Operator UI 操作

- `Esc` ボタンは常時表示で、tmuxへ Escape キーを送信します。
- `Restart` は復旧/オフライン時のみ表示されます。
- カーソルキーは常時表示（`↑`, `Select`, `↓`）。
- 現在のモバイル重視挙動では、operator panel は常時オープンを前提にしています。
- `operator-handle` / `close panel` は現在UIで非表示です。
- UIモード:
  - `pc`: デバッグパネルを表示したまま operator panel を利用
  - `mobile`: 半透明のほぼ全画面 operator panel + 常時 terminal mirror
- `PTT JA` / `PTT EN` は録音結果をテキストフォールバック入力欄へ追記します。既定はバッチASRで、実験的Realtime ASRを有効化すると、話している途中から増分文字起こしを表示できます。
- テキストフォールバック入力は、`operator_prompt` が無い状態でも常時利用可能です。
- テキスト行の操作:
  - `Send Text`（現在文字列を tmux/Codex へ送信）
  - `Clear`（入力欄クリア）
  - `Hide KB`（入力内容を保持したまま、入力欄を blur してキーボードを閉じる）
- `Esc` は送信前に入力フォーカスを外します。
- terminal mirror は読み取り専用です。

### ASR プロキシエンドポイント

ブラウザPTT音声は `face-app` の以下へPOSTされます。

```text
POST /api/operator/asr?lang=ja|en
```

`face-app` はバイナリ音声を ASR worker 用 JSON（`audioBase64`, `mimeType`）へ変換して転送します。

- `ja` -> `${MH_OPERATOR_ASR_BASE_URL}/v1/asr/ja`
- `en` -> `${MH_OPERATOR_ASR_BASE_URL}/v1/asr/en`

ASR関連環境変数:

- `MH_OPERATOR_ASR_BASE_URL`（既定: `http://127.0.0.1:8091`）
- `MH_OPERATOR_ASR_ENDPOINT_URL`（任意。明示エンドポイント上書き）
- `MH_OPERATOR_ASR_TIMEOUT_MS`（既定: `20000`）
- `MH_OPERATOR_ASR_MODEL_JA` / `MH_OPERATOR_ASR_MODEL_EN`（任意。上流モデル上書き）

実験的Realtime ASR（既定では無効）:

- `MH_OPERATOR_REALTIME_ASR_ENABLED=1` でブラウザWebSocketストリーミング経路を有効化
- `MH_OPERATOR_REALTIME_ASR_WS_URL` で `face-app` から vLLM realtime WebSocket を指定（統合スタック既定例: `ws://127.0.0.1:8090/v1/realtime`）
- `MH_OPERATOR_REALTIME_ASR_MODEL` で上流Realtimeモデル名を上書き（既定: `mistralai/Voxtral-Mini-4B-Realtime-2602`）
- `MH_OPERATOR_REALTIME_ASR_SAMPLE_RATE_HZ` でブラウザ側PCM16の目標サンプルレートを指定（既定: `16000`）
- `MH_STACK_START_REALTIME_ASR=1` で `run-operator-stack.sh` 内から `./scripts/run-vllm-voxtral.sh` を起動し、Realtime を自動で有効化
- `REALTIME_ASR_GPU_MEMORY_UTILIZATION` で vLLM の `--gpu-memory-utilization` を指定（既定: `0.88`）
- `MH_STACK_SKIP_ASR=1` で `run-operator-stack.sh` 内の batch `asr-worker` 起動をスキップし、VRAM消費を減らす
  - 既定のローカルASR先のまま `MH_OPERATOR_ASR_ENDPOINT_URL` 未指定でこれを使うと、`run-operator-stack.sh` はローカル batch ASR proxy も自動で無効化し、空振りフォールバックが `8091` を叩かないようにします

Realtime ASR 有効時は、`PTT JA` / `PTT EN` が既存の `face-app` WebSocket へPCM16音声チャンクを送り、ボタンを離す前から既存のテキストフォールバック入力欄へ増分文字起こしを表示します。Realtime ASR が無効・未接続・非対応ブラウザの場合は、従来どおり `MediaRecorder -> /api/operator/asr -> asr-worker` のバッチ経路を使います。

### iOS / Tailscale 運用手順

```bash
MH_BRIDGE_TMUX_PANE=agent:0.0 ./scripts/run-operator-stack.sh
tailscale serve --bg 8765
```

iPhone/iPad で Tailscale Serve URL を開いて利用します。

トラブルシュート（クイックチェック）:

- PTT文字起こしが返らない:
  - `curl -sS http://127.0.0.1:8091/health`
  - `run-operator-stack.sh` のログで `asr_upstream_not_configured` / timeout を確認
- Realtime ASR に接続できない:
  - `curl -sS http://127.0.0.1:8090/v1/models`
  - `MH_OPERATOR_REALTIME_ASR_WS_URL=ws://127.0.0.1:8090/v1/realtime` を確認
  - vLLM が空きVRAM不足を報告する場合は `REALTIME_ASR_GPU_MEMORY_UTILIZATION=0.85` などへ下げるか、`MH_STACK_SKIP_ASR=1` を使う
- 入力がエージェントに届かない:
  - `tmux display-message -p '#S:#I.#P'`
  - `MH_BRIDGE_TMUX_PANE` が `codex` 実行ペインと一致しているか確認
- 現在の作業を中断したい:
  - operator UI の常時表示 `Esc` を利用
- パネルが見えない（カスタムCSS等の影響）:
  - `FACE_UI_MODE=mobile|pc` を確認してページ再読み込み

<a id="ja-tts-model-files"></a>
## TTS モデルファイル（Kokoroのみ）

モデルを `assets/kokoro/` に配置してください。

- `kokoro-v1.0.onnx`
- `voices-v1.0.bin`

ダウンロード手順は `assets/kokoro/README.md` を参照してください。

任意の実験的 Qwen3-TTS セットアップ:

```bash
./scripts/setup-qwen3-tts.sh
```

このスクリプトは専用のローカル仮想環境 `./.venv-qwen-tts` を作成し、既定の Kokoro 経路を重くしないまま `qwen-tts` をそこへインストールします。
`flash-attn` が無くても、この経路ではまず動きます。その場合は手動 PyTorch 実装へフォールバックするため、速度は遅くなる可能性があります。

任意 backend を使うとき:

```bash
TTS_ENGINE=qwen3 ./scripts/run-tts-worker.sh --smoke
TTS_ENGINE=qwen3 ./scripts/run-face-app.sh
```

### Qwen3 発話挙動

Qwen3 backend は、Kokoro のような ASCII / 非ASCII の言語分割を行いません。1つの voice と 1つの language プロファイルで、発話全体をまとめて読みます。

実験的 Qwen3 経路の現在の既定値:

- `MH_QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- `MH_QWEN_TTS_SPEAKER=Serena`
- `MH_QWEN_TTS_LANGUAGE=English`
- `MH_QWEN_JA_ASCII_MODE=preserve`
- `MH_QWEN_TTS_STYLE=neutral`
- `MH_QWEN_TTS_GAIN=1.50`
- `MH_QWEN_TTS_SPEED=1.10`

現在の実験的既定値は、日本語と英語が混ざる実運用の聞き比べ結果を踏まえたものです。Kokoro のような ASCII / 非ASCII の言語分割ではなく、1つの Qwen3 音声で全文を読む前提です。
現在の `English` プロファイルでは、音声用テキストが CJK 漢字で始まる場合（例: 漢字始まりの日本語文）、Qwen3 経路は音声生成時だけ内部的に `はい、` を前置きします。表示テキスト自体は変わりません。これにより、文頭の読みを安定させやすくしています。
選んだ Qwen3 話者の声量が小さすぎる、または強すぎると感じる場合は、`MH_QWEN_TTS_GAIN` を調整してください（例: `1.0`, `1.25`, `1.50`）。ピークが 1.0 を超える場合は、ハードクリップを避けるため自動で少し抑えます。
少し遅く感じる場合は、`MH_QWEN_TTS_SPEED` を調整してください（例: `1.0`, `1.10`, `1.20`）。`1.0` より大きい値は、より速く話します。

## Speech Gate 設定（`config.yaml`）

`face-app` は起動時にリポジトリルートの `config.yaml`（または `FACE_CONFIG_PATH`）を読み、発話ゲート設定を適用します。

既定値（発話しやすめ設定）:

```yaml
speech_gate:
  min_interval_priority1_ms: 1500
  global_window_ms: 60000
  global_limit_low_priority: 24
  session_window_ms: 60000
  session_limit_low_priority: 12
  dedupe_ms_low_priority: 800
```

各フィールドの対応:

- `min_interval_priority1_ms` -> `priority=1` の最小間隔
- `global_limit_low_priority` in `global_window_ms` -> `priority<=2` の全体上限
- `session_limit_low_priority` in `session_window_ms` -> `priority<=2` のセッション上限
- `dedupe_ms_low_priority` -> `priority<=2` で同一 `dedupe_key` の抑制時間

## 長文発話の挙動

- `face.say` の `ttl_ms` 未指定時既定は `60000`（60秒）
- `FACE_SAY_DEFAULT_TTL_MS` で上書き可能（`mcp-server`）
- `face-app` は `config.yaml` の `tts.default_ttl_ms` に対応
- `face-app` は `tts.auto_interrupt_after_ms` に対応（一定時間後の `replace` を `interrupt` 扱いへ昇格）

発話中に新しい `face.say` が来た場合:

- `policy=replace`: 現在発話を継続し、最新1件のみ保留
- `policy=interrupt`（または `priority=3`）: 現在発話を停止し新規発話を即時開始

## 発話言語ルーティング（Kokoroのみ）

- ASCIIのみの文字列 -> 英語音声（`en-us`, speed `1.0`）
- 非ASCIIを含む文字列 -> 日本語音声（`j`, speed `1.2`）

### 英語正規化仕様

`face.say` テキストに対して発話前に適用されます。Kokoro / Qwen3 のどちらでも共通ですが、直前の「言語ルーティング」は Kokoro のみです。

- `‘` / `’` -> `'`
- `“` / `”` -> `"`
- `…` / `...` -> 半角スペース
- `。` / `、` / `・` -> 半角スペース
- NBSP (`U+00A0`) / NNBSP (`U+202F`) -> 半角スペース
- 結合文字を含むラテン文字はASCII正規化
  - `café -> cafe`, `naïve -> naive`, `rôle -> role`
- 英語向けインラインダッシュ正規化は維持
  - `9-to-5 -> 9 to 5`
- 全角記号/日本語文字は保持
- 正規化結果が空なら発話スキップ

これは、face-app 側の共通正規化と、tts-worker 側の backend ごとの音声合成で実装されています。Kokoro はこの後に上記の言語ルーティングも行います。

<a id="ja-mcp-client-config"></a>
## MCPクライアント設定

個人用ローカル設定ファイルはリポジトリにコミットしないでください。

### Codex CLI 例

`doc/examples/codex/config.toml` をテンプレートとして使い、各自の絶対パスへ置き換えてください。

MCPクライアントがドット付きツール名（例: `face.event`）を受け付けない場合:

```toml
env = { FACE_WS_URL = "ws://127.0.0.1:8765/ws", MCP_TOOL_NAME_STYLE = "underscore" }
```

公開ツール名は次の形になります。

- `face_event`
- `face_say`
- `face_ping`

### Antigravity 例

`doc/examples/antigravity/mcp_config.json` をテンプレートとして使い、各自の絶対パスへ置き換えてください。

エージェント側シグナリング規約は `doc/examples/AGENT_RULES.md` を参照してください。

## オプションスキル

`doc/examples/skills/` に再利用可能なスキルを同梱しています。

- `release-ci-flow`
- `minimum-headroom-ops`
- `looking-glass-webxr-setup`

各フォルダには `SKILL.md` があり、対応エージェントではローカルスキルディレクトリ（例: `$CODEX_HOME/skills/`）へコピーして利用できます。

## リリースチェックリスト

- テスト実行:

```bash
npm test
```

- MCP起動確認:

```bash
./scripts/run-mcp-server.sh
```

- face-app起動とブラウザ表示確認:

```bash
./scripts/run-face-app.sh
```

- TTS worker smoke確認:

```bash
npm run tts-worker:smoke
```

- ASR worker smoke確認:

```bash
npm run asr-worker:smoke
```

- operator stack起動確認（tmux内 or `MH_BRIDGE_TMUX_PANE` 指定）:

```bash
./scripts/run-operator-stack.sh
```

## 補足

- 実行時ローカルファイル（モデル、ローカルMCP設定、キャッシュ、venv など）は `.gitignore` で除外されています。
