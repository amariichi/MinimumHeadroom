---
name: minimum-headroom-ops
description: Operate and troubleshoot minimum-headroom runtime components (face app, mcp server, tts worker, websocket signaling) with reproducible checks.
---

# Minimum Headroom Ops

Use this skill when the user asks to start, verify, or diagnose runtime behavior of minimum-headroom.

## Runtime components

- `face-app`: browser UI and websocket hub (`ws://127.0.0.1:8765/ws`)
- `mcp-server`: stdio MCP bridge forwarding to face websocket
- `tts-worker`: Python Kokoro worker process used by face-app

## Standard startup order

From repository root:

```bash
./scripts/setup.sh
./scripts/run-face-app.sh
```

In another terminal:

```bash
./scripts/run-mcp-server.sh
```

## Health checks

1. Unit test baseline:

   ```bash
   npm test
   ```

2. Face app reachable:

   ```bash
   curl -I http://127.0.0.1:8765/
   ```

3. MCP forwarding smoke test (Node 24+):

   ```bash
   node -e 'const ws=new WebSocket("ws://127.0.0.1:8765/ws");ws.onopen=()=>{ws.send(JSON.stringify({v:1,type:"ping",session_id:"ops#smoke",ts:Date.now()}));setTimeout(()=>ws.close(),300)};'
   ```

4. TTS worker availability:

   ```bash
   npm run tts-worker:smoke
   ```

## Frequent failure modes

- `MCP startup failed` or timeout:
  - Use absolute Node path in client config if PATH differs from interactive shell.
  - Confirm `command` and `args` point to an existing `mcp-server/dist/index.js`.
  - Increase `startup_timeout_sec` only after fixing path and handshake issues.

- TTS is silent:
  - Confirm model files exist in `assets/kokoro/`.
  - On Linux, install PortAudio or use ALSA fallback.
  - Check face-app log lines for `tts worker ready` and backend name.

- `XR NOT SUPPORTED` while Looking Glass Bridge is running:
  - Verify Chromium/Firefox usage.
  - Confirm polyfill is applied before XR session request.
  - Use monitor mode fallback while troubleshooting.

## Agent signaling policy

When MCP is available, emit:

- `face_ping` near task start
- `face_event` on important boundaries
- `face_say` for high-value notices

For concrete timing and priority rules, follow `doc/examples/AGENT_RULES.md`.
