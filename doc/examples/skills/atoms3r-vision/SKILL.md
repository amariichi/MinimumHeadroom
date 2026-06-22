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
curl -s "$BASE/situation"                  # situational digest: now + how long stable + tiered history (NO GPU)
curl -s "$BASE/situation?format=text"      # the same digest as a compact Japanese text block
curl -s -X POST "$BASE/look"               # "what do you see right now?": fresh frame, run the model, return its description
curl -s -X POST "$BASE/capture" -o /tmp/now.jpg   # Mode A: grab ONE fresh frame now (no GPU; read it yourself)
curl -s "$BASE/latest"            # most recent stored observation (incl. frame_id)
curl -s "$BASE/previous"          # the one before that
curl -s "$BASE/diffs?n=50"        # rolling window of recent change observations
curl -s "$BASE/search?q=problem"  # substring search over OCR text + overview
curl -s "$BASE/frame/12" -o /tmp/frame.jpg   # original full-resolution stored JPEG by id
curl -s "$BASE/metrics"           # counts + pipeline stats
curl -s -X POST "$BASE/perception/start"   # Mode B: start continuous watching (gated; see below)
curl -s -X POST "$BASE/perception/stop"    # Mode B: stop continuous watching
curl -s "$BASE/perception/status"          # running? locked? capability?
```

Each observation looks like:

```json
{"frame_id": 12, "is_text": true, "overview": "a workbook page",
 "ocr_full": "Problem 12. ...", "change_from_prev": "page turned to problem 12",
 "low_confidence": false, "captured_at": "2026-..."}
```

`low_confidence: true` means treat the text as especially unreliable — fetch the frame.

## Staying in sync with the camera (the situational digest)

So a spoken conversation stays coherent, the camera and you must share the same
picture of "now". `GET /situation` gives you that in one cheap, read-only call
that runs **no** model (safe to read on every turn): the current scene, how many
seconds it has been **stable** (unchanged), the recent raw changes, and a
multi-resolution history — recent detail plus progressively coarser summaries
(`直近` ≈ 10 min, `1時間`, `6時間`, `1日`). The coarser summaries are produced by
condensing text during idle moments and cached, so reading is always free.

- Use `GET /situation` (or `?format=text` for a ready-to-read block) whenever the
  user refers to what is around them, what is on screen, "now", or "how long has
  it been like this" / "what changed earlier". You can answer from the digest
  without taking a fresh picture.
- This digest can also be **auto-injected** into your context every turn (Design
  B) via `scripts/situation-context-hook.sh` wired as a `UserPromptSubmit` hook
  (set `MH_SITUATION_INJECT=1`). When that is on, you already have the current
  situation each turn and need not call anything.
- For a deliberate fresh look — "what do you see **right now**?" — use
  `POST /look`: it grabs one frame and runs the model immediately, returning its
  description (bypassing the change-gate so you always get a fresh answer). For
  accuracy-sensitive reads, still fetch the full frame and read it yourself.

Always relay the safety boundary when relevant; the digest text already carries a
short disclaimer.

## Two ways to use the camera

- **Mode A — on-demand (default).** The user asks about what they are pointing
  at right now ("read this", "explain problem 14"). Grab one fresh frame and read
  it yourself. No continuous loop, no GPU; the camera only "looks" when asked.
- **Mode B — continuous watching.** Ambient monitoring ("tell me if you see a red
  light"). Start a background loop. Needs the GPU model and is gated (see below).

## Recipes

**"Can you read problem 14 / explain what I'm pointing at?"** (Mode A — primary)

```bash
curl -s -X POST "$BASE/capture?full=1" -o /tmp/now.jpg
```
Then **read `/tmp/now.jpg` with your own vision** and answer from the actual
image. This is the most accurate path; do not rely on stored OCR text.

**"What is the camera seeing right now?"** (quick, if a loop is already running)

```bash
curl -s "$BASE/latest"     # otherwise use /capture and look yourself
```

**"What has changed recently?"** (needs Mode B running)

```bash
curl -s "$BASE/diffs?n=50"     # summarize change_from_prev, newest first
```

**"Tell me if you see a red light." / "Watch the door."** (Mode B)

```bash
curl -s -X POST "$BASE/watches" -H 'Content-Type: application/json' \
  -d '{"name":"red light","rule":"red","kind":"keyword"}'
curl -s -X POST "$BASE/perception/start"
```
Relay the returned safety disclaimer. **"Stop watching"** → `POST /perception/stop`.
**"Are you watching?"** → `GET /perception/status`.

## Controlling Mode B (the gating policy)

`POST /perception/start` returns `started: true/false`. When false, `reason`
tells you what to do — relay it to the user, and never silently stop another
program:

- `locked` — continuous watching is disabled by policy; only Mode A works.
- `needs_model_start` — the model is not running but there is enough free GPU
  memory to start it without displacing anything. Ask the user, then run
  `./scripts/run-vllm-diffusiongemma.sh`.
- `insufficient_vram` — starting the model would require freeing the GPU (i.e.
  stopping the other local LLM). **Confirm with the user first.**
- `no_camera` — no camera is configured.

`GET /perception/status` reports `capability` (`available` / `running` /
`locked` / `needs_model_start` / `needs_vram`) so you can explain the current
state before acting.

## Notes

- Extract a field without `jq`:

  ```bash
  curl -s "$BASE/latest" | python3 -c "import sys,json;print(json.load(sys.stdin)['frame_id'])"
  ```
- If `/healthz` is unreachable, the camera stack is not running; tell the user how to start it (`./scripts/run-vision-worker.sh`, plus the diffusiongemma backend for real OCR) rather than guessing.
- This skill is read-only except for `POST /watches`.
