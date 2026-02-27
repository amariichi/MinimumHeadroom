# asr-worker

Parakeet EN/JA を使うローカルASRワーカーです。`minimum-headroom` から HTTP で呼び出します。

`audio/webm` など `soundfile` で直接読めない形式は、`ffmpeg` が利用可能な場合に自動で WAV へ変換してからデコードします。

## Endpoints

- `GET /health`
- `POST /v1/asr/fast`
- `POST /v1/asr/en`
- `POST /v1/asr/ja`
- `POST /v1/asr/mixed`

## Run

初回セットアップ（推奨, repo root から）:

```bash
uv sync --project asr-worker --locked
# または repo root で npm run setup
```

起動:

```bash
uv run --project asr-worker asr-worker
```

デフォルト: `http://127.0.0.1:8091`

要件: `ffmpeg` を PATH から実行できること（webm/ogg/mp4 などのフォールバック変換に使用）。

デバイス設定:

- `ASR_DEVICE=cuda` (default)
- `ASR_DEVICE=cpu` (macOS / CPU-only 環境、またはVRAM制約が厳しい場合)
- `ASR_FAST_CLIP_SECONDS=8.0` (fast判定の最大長)
- `ASR_SINGLE_MODEL_CACHE=true` (default, GPU時は1モデルだけ保持してOOMを避ける)
- `ASR_PRELOAD_MODELS=false` (default, `true` で起動時に EN/JA を事前ロード)

同時常駐設定 (`ASR_SINGLE_MODEL_CACHE=false` + `ASR_PRELOAD_MODELS=true`) は環境によって CUDA 不安定化が起こることがあります。  
`npm run asr-worker:start` は `ASR_ENABLE_CUDA_FALLBACK=true` のとき、クラッシュ検知後に `single cache` へ1回自動フォールバックします。

## Smoke

```bash
uv run --project asr-worker asr-worker --smoke
```

## Request format

```json
{
  "audioBase64": "....",
  "mimeType": "audio/webm",
  "model": "optional-override"
}
```

## Response format

```json
{
  "text": "transcript",
  "language": "ja|en|mixed|unknown",
  "languageConfidence": { "ja": 0.8, "en": 0.2 },
  "jaConfidence": 0.8,
  "enConfidence": 0.2,
  "clipped": false,
  "audioSeconds": 3.217
}
```
