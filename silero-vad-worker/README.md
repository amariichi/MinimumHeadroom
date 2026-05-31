# silero-vad-worker

Local Silero VAD worker. Sibling to `asr-worker`; runs on the PC and
performs voice-activity detection on PCM16 audio frames forwarded by the
face-app Atom audio bridge.

The worker is optional. Without it, the bridge falls back to the
deterministic RMS-energy VAD baked into `face-app/dist/atom_audio_vad_bridge.js`.
Selection is controlled by `MH_ATOM_VAD_BACKEND=rms|silero` in face-app's
environment.

## Why it exists

The RMS-energy backend works well in a quiet room but cannot tell
"speech" from "wind / traffic / cafe music" once the noise floor crosses
its threshold. Silero is a small (~2 MB) learned VAD that reliably
distinguishes speech from environmental noise at very low CPU cost.

## Install

```
cd silero-vad-worker
uv sync
```

## Run

```
silero-vad-worker --host 127.0.0.1 --port 8092
```

Environment variables:

- `SILERO_DEVICE` / `MH_SILERO_DEVICE` — `cpu` (default) or `cuda`. CPU
  is recommended; the model is tiny and CPU avoids GPU launch overhead.
- `SILERO_HOST` / `SILERO_PORT` — used by the operator stack launcher.

## API

### `GET /health`

```
{
  "ok": true,
  "service": "silero-vad-worker",
  "device": "cpu",
  "sampleRates": [8000, 16000]
}
```

### `POST /v1/vad`

```
{
  "audioBase64": "<PCM16-LE samples>",
  "sampleRate": 16000,
  "threshold": 0.5
}
```

Response:

```
{
  "is_speech": true,
  "speech_prob": 0.93,
  "chunks": 2,
  "durationMs": 64.0,
  "device": "cpu"
}
```

The caller passes a whole AtomS3R audio frame (1024 samples = 64 ms at
16 kHz). The worker re-chunks internally to the 512-sample windows the
Silero model expects and returns the maximum speech probability over
those chunks. `is_speech` is the boolean comparison against `threshold`;
the caller can ignore that field and threshold `speech_prob` itself for
a stricter rule.

## Smoke test

```
silero-vad-worker --smoke
```

Loads silero-vad and exits, useful for verifying the install without
binding a port.
