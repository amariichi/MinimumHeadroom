---
name: atoms3r-vision
description: The AtomS3R-M12 camera as a hands-free ambient scene companion — what it sees now, how long it's been stable, what changed recently, a one-shot "what do you see?", and spoken visual alerts. Its fixed soft lens reads only large text/signs, NOT fine print; route documents/labels/homework to the phone-camera path instead.
---

# AtomS3R-M12 Vision — ambient scene companion

Use this skill when the user asks what the camera is **currently** or was **recently** seeing, asks **"what do you see?"** about the scene around them, wants to know **how long** things have looked the same or **what changed earlier**, or wants to **register a spoken alert** ("tell me if you see a red light").

The camera (an AtomS3R-M12 kit) streams frames to a local service, `vision-worker`, which keeps a small rolling memory: the latest observation, the previous one, and roughly the last 50 *changes*, plus progressively coarser time-tier summaries. Each observation has a one-line `overview`, a one-line `change_from_prev`, and an `ocr_full` (text the model could read). Frames are stored on disk and retrievable by id.

## ⚠️ What the M12 can and cannot read

The M12 has a **fixed, soft (slightly out-of-focus) wide lens** and streams a small VGA frame to stay mobile-frugal. It is good at **scenes and objects** (a desk, a person, a door, a box, big signage) and can read **large text only** (a sign, a big label, a slide heading) into `ocr_full`. It **cannot** reliably read fine print: documents, book pages, homework problems, small labels, screens of dense text.

- For **scene / object / "what's around me"** questions → this skill is the right tool.
- For **fine reading** (documents, labels, homework, dense screens) → do **not** use the M12; route the user to the **phone-camera path** instead (a separate capability). Say so plainly rather than returning an unreliable transcription.
- `ocr_full` is reliable only for large text; treat it as a hint, never as an exact transcription. Fetching the full stored frame (`GET /frame/{id}`) lets you look yourself, but the lens is still soft — it does not turn the M12 into a document scanner. `full`-resolution capture is **not** worth the bandwidth and does not sharpen the soft optics.

## ⚠️ Safety boundary

This is informational/assistive only. The camera samples slowly (~0.5 fps) over the network, so it must **not** be relied on for safety-critical alerts such as street crossing or driving. Say so if the user asks for that.

## Service address

Default base URL: `http://127.0.0.1:8095` (override with `VISION_BASE_URL`). When the camera is carried standalone, the service still runs on the home PC and is reached over Tailscale, so the base URL may be a Tailscale address.

When the `minimum_headroom` MCP server exposes `vision_situation` and
`vision_look`, prefer those tools over shell `curl`: they read `VISION_BASE_URL`
from the host-side MCP process and avoid per-agent localhost/network approval
differences. Never infer camera availability from process lists, browser tabs,
or tmux panes; use the digest tool or say the digest path is unavailable.

```bash
BASE="${VISION_BASE_URL:-http://127.0.0.1:8095}"
curl -s "$BASE/healthz"
```

## Endpoints

```bash
curl -s "$BASE/situation"                  # situational digest: now + how long stable + tiered history (NO GPU)
curl -s "$BASE/situation?format=text"      # the same digest as a compact Japanese text block
curl -s -X POST "$BASE/look"               # "what do you see right now?": fresh frame, run the model, return its description (stores to the shared timeline by default; add ?store=0 for an ephemeral peek)
curl -s -X POST "$BASE/capture" -o /tmp/now.jpg   # Mode A: grab ONE fresh frame now (no GPU; read it yourself)
curl -s "$BASE/latest"            # most recent stored observation (incl. frame_id)
curl -s "$BASE/previous"          # the one before that
curl -s "$BASE/diffs?n=50"        # rolling window of recent change observations
curl -s "$BASE/search?q=mug"      # substring search over overview + any read text
curl -s "$BASE/frame/12" -o /tmp/frame.jpg   # original full-resolution stored JPEG by id
curl -s "$BASE/metrics"           # counts + pipeline stats
curl -s -X POST "$BASE/perception/start"   # Mode B: start continuous watching (gated; see below)
curl -s -X POST "$BASE/perception/stop"    # Mode B: stop continuous watching
curl -s "$BASE/perception/status"          # running? locked? capability?
curl -s -X POST "$BASE/correction" -H 'Content-Type: application/json' \
  -d '{"text":"赤信号に見えるのは救急車の赤色灯"}'             # correct a camera misread (see below)
curl -s "$BASE/corrections"                # list still-active corrections
curl -s -X DELETE "$BASE/corrections"      # clear all corrections
```

Each observation looks like:

```json
{"frame_id": 12, "is_text": false, "overview": "a desk with a book and a mug",
 "ocr_full": "", "change_from_prev": "a mug was placed on the desk",
 "low_confidence": false, "captured_at": "2026-..."}
```

`low_confidence: true` means treat the observation as especially unreliable. `is_text`/`ocr_full` are populated only when large, legible text fills the frame; for ordinary scenes `ocr_full` is empty.

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
- If the MCP `vision_situation` tool is available, use it for the same purpose
  instead of shelling out to `curl`.
- This digest can also be **auto-injected** into your context every turn (set
  `MH_SITUATION_INJECT=1`). Use `scripts/situation-context-hook.sh` for
  Claude-style plain-text `UserPromptSubmit` hooks,
  `scripts/situation-context-hook-codex.mjs` for Codex, and
  `scripts/situation-context-hook-agy.mjs` for Antigravity (`PreInvocation` →
  transient `ephemeralMessage`). When that is on, you already have the current
  situation each turn and need not call anything.
- The digest may include `見覚え:` lines — named things seen 1 hour to 14 days
  ago that are NOT in the current view. They are callback material for natural
  conversation ("そういえば昨日の箱、開けました?"), not a list to recite.
- For a deliberate fresh look — "what do you see **right now**?" — use
  `POST /look`: it grabs one frame, runs the model immediately, returns its
  description, and (by default) commits it to the shared rolling memory so the
  one-shot joins the same timeline as the ambient loop — keeping your memory and
  the camera's in step. An unchanged scene adds no duplicate. Pass `?store=0`
  for a purely ephemeral peek. For accuracy-sensitive reads, still fetch the full
  frame and read it yourself.
- If the MCP `vision_look` tool is available, use it for the same deliberate
  fresh-look path.

Always relay the safety boundary when relevant; the digest text already carries a
short disclaimer.

### Standing instruction for injected camera context

When `scripts/situation-context-hook.sh` injects a `[カメラ ...]` or
`[カメラの状況 ...]` block, treat it as ambient background. Do not mention the
camera or its contents unless it is relevant to the user's turn. When the user
refers to their surroundings, what is visible, what changed, or how long the
scene has been stable, answer from the injected block or pull `GET /situation` /
`POST /look` for more detail. When the user contradicts a camera-derived claim,
post that clarification to `POST /correction` so the worker stops repeating the
misread and the note reaches future summaries.

### Optional per-turn injection setup

For Claude-style `UserPromptSubmit` hooks, first put runtime configuration in the
operator environment (normally via `~/.config/minimum-headroom.env`):

```bash
export MH_SITUATION_INJECT=1
export VISION_BASE_URL=http://127.0.0.1:8095
```

Then register the hook once in the conversational agent settings. This is a
documentation snippet only — do not edit user settings programmatically:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/ABS/PATH/minimum-headroom/scripts/situation-context-hook.sh"
          }
        ]
      }
    ]
  }
}
```

Codex and agy have equivalent injection wrappers around the same plain hook.
For Codex, use `scripts/situation-context-hook-codex.mjs`, which wraps the
output as `UserPromptSubmit.hookSpecificOutput.additionalContext` (registered
by `start-rmh.sh` via `codex -c`). For agy, use
`scripts/situation-context-hook-agy.mjs`, registered as a `PreInvocation` hook
in the minimum-headroom plugin's `hooks.json`; it injects the digest as a
transient `ephemeralMessage` and keys the salience watermark to the agy
conversation via `MH_SITUATION_SESSION_KEY`. When no injection hook is active,
fall back to pull: call the MCP `vision_situation` tool, or `GET /situation`
when the MCP tool is unavailable, when the user asks about the surroundings.
Use `vision_look`, or `POST /look` when the MCP tool is unavailable, for a
deliberate fresh view.

## Two ways to use the camera

- **Mode A — on-demand (default).** The user asks what's in front of them right
  now ("what's on the desk?", "what do you see?"). Take one fresh look. No
  continuous loop; the camera only "looks" when asked.
- **Mode B — continuous watching.** Ambient monitoring ("tell me if you see a red
  light"). Start a background loop. Needs the GPU model and is gated (see below).

## Recipes

**"What do you see right now? / What's on the desk?"** (Mode A — primary)

```bash
curl -s -X POST "$BASE/look"   # fresh frame, model describes it now; joins memory
```
Answer from the returned `overview`. For a closer look at a *scene* you can also
grab the frame and view it yourself (`POST /capture -o /tmp/now.jpg`), but
remember the lens is soft — this is not for fine reading.

**"Can you read this document / problem / label?"** (fine reading)

The M12 cannot do this reliably (soft fixed lens). Tell the user to use the
**phone-camera path** for fine reading rather than returning a guess.

**"What is the camera seeing right now?"** (quick, if a loop is already running)

```bash
curl -s "$BASE/situation"     # current scene + how long stable; or /latest, or /look
```

**"What has changed recently?"** (needs Mode B running)

```bash
curl -s "$BASE/diffs?n=50"     # summarize change_from_prev, newest first
```

**"Tell me if you see a red light." / "Watch the door."** (Mode B)

```bash
curl -s -X POST "$BASE/watches" -H 'Content-Type: application/json' \
  -d '{"name":"red light","rule":"赤","kind":"keyword"}'
curl -s -X POST "$BASE/perception/start"
```
Keyword watch rules must be written in the worker output language (`VISION_OUTPUT_LANG`; Japanese, `ja`, in the live stack), so use `"赤"` rather than `"red"` when the worker describes scenes in Japanese.
Relay the returned safety disclaimer. **"Stop watching"** → `POST /perception/stop`.
**"Are you watching?"** → `GET /perception/status`.

## When the user corrects what the camera reported

The camera and the model perceive one-directionally: they describe the scene, you
read it, but your conversation never flows back to them. So if the model mislabels
something (classic case: it calls an ambulance's flashing red beacon a "red
traffic light") and you relay it, the user's correction ("no, that's an
ambulance") would otherwise be lost — the digest keeps re-asserting the misread
every turn. **Post the correction back** so the digest stops repeating it:

```bash
curl -s -X POST "$BASE/correction" -H 'Content-Type: application/json' \
  -d '{"text":"赤信号に見えるのは救急車の赤色灯"}'
```

The note is **bound to the current scene** and retires itself automatically once
the scene changes, the view drifts, or a short cap (~2 min, `VISION_CORRECTION_TTL_S`)
elapses — so it can never haunt an unrelated later scene. After posting, the
injected digest carries a `[人の補足] …` line until it lapses; when that line
shows `まだ有効か…確認してください`, ask the user whether the correction still
holds and re-post it if so. Do this whenever the user contradicts a camera-derived
statement; you can pass an explicit `ttl_s` to shorten or extend a one-off note.
`POST /correction` returns **409** if nothing has been observed yet (no scene to
attach to) — take a look first.

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
- If `/healthz` is unreachable, the camera stack is not running; tell the user how to start it (`./scripts/run-vision-worker.sh`, plus the diffusiongemma backend for model-based scene description) rather than guessing.
- Mostly read-only, but note the writes: `POST /look` (default) and Mode B commit observations to the rolling memory, `GET /situation` caches tier summaries, `POST /watches` registers an alert, and `POST /correction` records a scene-bound human correction (kept in memory only; dropped on restart).
