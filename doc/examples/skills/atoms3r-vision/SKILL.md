---
name: atoms3r-vision
description: Query the AtomS3R-M12 camera's rolling visual memory — what the camera sees now or saw recently, OCR of a document in view, and registering simple spoken visual alerts. For accurate reads, fetch the full-resolution frame and read it directly.
---

# AtomS3R-M12 Vision Memory

Use this skill when the user asks about what the camera is **currently** or was **recently** seeing, wants you to **read/solve** something visible in the camera (a workbook problem, a sign, a screen), or wants to **register a spoken alert** ("tell me if you see a red light").

The camera (an AtomS3R-M12 kit) streams frames to a local service, `vision-worker`, which keeps a small rolling memory: the latest observation, the previous one, and roughly the last 50 *changes*. Each observation has a fast OCR transcription (`ocr_full`), a one-line `overview`, and a one-line `change_from_prev`. The original full-resolution frames are stored on disk and retrievable by id.

## ⚠️ Accuracy: the stored text is an index, not the answer

`ocr_full` comes from a fast vision model and may be imperfect. **For any accuracy-sensitive request** (solving a problem, reading fine print, transcribing exactly), do **not** answer from `ocr_full`. Instead:

1. find the relevant observation (it carries a `frame_id`),
2. download the full-resolution frame: `GET /frame/{frame_id}`,
3. **read that image with your own vision**, then answer.

Use `ocr_full`/`overview` only to locate the right frame and for quick "what's there?" answers.

## ⚠️ Safety boundary

This is informational/assistive only. The camera samples slowly (~0.5 fps) over the network, so it must **not** be relied on for safety-critical alerts such as street crossing or driving. Say so if the user asks for that.

## Service address

Default base URL: `http://127.0.0.1:8095` (override with `VISION_BASE_URL`). When the camera is carried standalone, the service still runs on the home PC and is reached over Tailscale, so the base URL may be a Tailscale address.

```bash
BASE="${VISION_BASE_URL:-http://127.0.0.1:8095}"
curl -s "$BASE/healthz"
```

## Endpoints

```bash
curl -s "$BASE/latest"            # most recent observation (incl. frame_id)
curl -s "$BASE/previous"          # the one before that
curl -s "$BASE/diffs?n=50"        # rolling window of recent change observations
curl -s "$BASE/search?q=problem"  # substring search over OCR text + overview
curl -s "$BASE/frame/12" -o /tmp/frame.jpg   # original full-resolution JPEG by frame_id
curl -s "$BASE/metrics"           # counts + pipeline stats
```

Each observation looks like:

```json
{"frame_id": 12, "is_text": true, "overview": "a workbook page",
 "ocr_full": "Problem 12. ...", "change_from_prev": "page turned to problem 12",
 "low_confidence": false, "captured_at": "2026-..."}
```

`low_confidence: true` means treat the text as especially unreliable — fetch the frame.

## Recipes

**"What is the camera seeing right now?"**

```bash
curl -s "$BASE/latest"
```
Answer from `overview` (and `ocr_full` for a quick gist).

**"Explain how to solve problem 12 in this workbook."** (accuracy-sensitive)

```bash
# 1) locate the frame
curl -s "$BASE/search?q=12"        # or /latest if it's what's in view now
# 2) fetch the full-resolution frame for the chosen frame_id
curl -s "$BASE/frame/<frame_id>" -o /tmp/vision_frame.jpg
```
Then **read `/tmp/vision_frame.jpg` with your own vision** and explain from the actual image — not from `ocr_full`.

**"What has changed recently?"**

```bash
curl -s "$BASE/diffs?n=50"
```
Summarize the `change_from_prev` entries (newest first).

**"Tell me if you see a red light."** (register a watch — alerting itself is delivered by the worker, M5)

```bash
curl -s -X POST "$BASE/watches" -H 'Content-Type: application/json' \
  -d '{"name":"red light","rule":"red","kind":"keyword"}'
```
Relay the returned safety disclaimer to the user.

## Notes

- Extract a field without `jq`:

  ```bash
  curl -s "$BASE/latest" | python3 -c "import sys,json;print(json.load(sys.stdin)['frame_id'])"
  ```
- If `/healthz` is unreachable, the camera stack is not running; tell the user how to start it (`./scripts/run-vision-worker.sh`, plus the diffusiongemma backend for real OCR) rather than guessing.
- This skill is read-only except for `POST /watches`.
