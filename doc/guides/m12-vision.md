# AtomS3R-M12 Vision Guide

This guide explains the AtomS3R-M12 vision subsystem: a small ambient scene
memory that local coding agents and the conversational LLM can query. The M12
camera provides frames, `vision-worker` turns changed scenes into structured
records with diffusiongemma, SQLite stores the short-term memory, and
`GET /situation` exposes a cheap digest for agents.

## English

### What The Subsystem Does

The M12 vision path is designed for ambient situational awareness, not high-risk
automation. It lets an agent answer what the camera sees now, how long that view
has been stable, what changed recently, whether a keyword watch fired, and
whether a user correction is active.

The worker is split into low-cost layers: `NetworkCaptureSource` pulls JPEGs,
`ChangeGate` avoids unnecessary model calls, `Pipeline` reconciles structured
model observations, `VisionDB` and `FrameStore` persist tier-0 memory,
`summarize.py` builds older-history summaries, and `situation.py` renders the
digest that agents read.

The M12 lens is useful for scenes, objects, and large text. It is not a document
scanner. Fine print, homework pages, dense screens, and small labels should go
through a phone-camera or direct image path instead.

### Perception Flow

This is the live frame-to-record path used by the continuous perception loop and
by stored on-demand looks. The key point is that the cheap gate runs before the
heavy model, while the model's own `changed` verdict is still the authority for
whether a committed row represents a meaningful scene change.

```mermaid
flowchart LR
  subgraph Device["AtomS3R-M12 device"]
    Sensor["Camera sensor"]
    Snapshot["/snapshot HTTP endpoint"]
  end
  subgraph Capture["vision_worker.capture"]
    Net["NetworkCaptureSource.capture"]
    Auth["X-Headroom-Auth header"]
    Rotate["optional JPEG rotation"]
  end
  subgraph Gate["vision_worker.gate"]
    Hash["average hash"]
    Pixel["32px gray pixel diff"]
    Changed{"changed enough?"}
  end
  subgraph Pipeline["vision_worker.pipeline"]
    Window["pending voting window"]
    Observe["model_client.observe"]
    Reconcile["vote.reconcile medoid"]
    Commit{"meaningful change?"}
  end
  subgraph Model["diffusiongemma via vLLM"]
    VLLM["OpenAI-compatible /chat/completions"]
    Record["Observation JSON: is_text, ocr_full, overview, changed, change_from_prev"]
  end
  subgraph Tier0["SQLite tier 0"]
    Frames["frames table + stored JPEG paths"]
    Observations["observations table"]
  end
  Sensor --> Snapshot
  Net -- "HTTP GET with auth token" --> Snapshot
  Auth --> Net
  Snapshot -- "JPEG bytes" --> Rotate
  Rotate --> Hash
  Rotate --> Pixel
  Hash --> Changed
  Pixel --> Changed
  Changed -- "no, no open vote" --> Suppress["gate_suppressed"]
  Changed -- "yes, or open vote needs samples" --> Window
  Window --> Observe
  Observe --> VLLM
  VLLM --> Record
  Record --> Reconcile
  Reconcile --> Commit
  Commit -- "false or duplicate" --> Drop["nochange or dedup suppressed"]
  Commit -- "true or first baseline" --> Frames
  Commit -- "true or first baseline" --> Observations
```

Implementation notes: `run-vision-stack.sh` resolves `VISION_CAMERA_URL` to
`<m12-base>/snapshot`; `NetworkCaptureSource` sends `X-Headroom-Auth` from
`VISION_CAMERA_AUTH_TOKEN` or `MH_FACE_AUTH_TOKEN`; `ChangeGate.is_changed()`
combines average-hash Hamming distance with downscaled pixel diff; and
`Pipeline._commit()` writes the original frame plus the observation row before
firing alert/narration callbacks. The model prompt passes only previous text,
not the previous image, so every diffusiongemma call does one image prefill.

### Memory Lifecycle And Forgetting

The worker keeps two related memories:

- Tier 0: raw change records plus frame paths.
- Tiers 1-4: cached text summaries of closed time buckets.

Recent events stay verbatim. Older events are summarized into coarser buckets.
Forgetting is explicit: old observations are pruned after they are safe to
summarize, and each summary tier has a retention cap.

```mermaid
flowchart TB
  Commit["Pipeline._commit writes a change point"]
  T0["Tier 0: frames + observations"]
  Recent["GET /situation recent[]"]
  Stable["stable_seconds = last_observed_at - changed_at"]
  Stale["stale when observing but frames stop arriving"]

  Band1["closed 10 minute bands"]
  T1["Tier 1 summaries: 10 minute buckets"]
  Band2["closed 1 hour bands"]
  T2["Tier 2 summaries: hourly buckets"]
  Band3["closed 6 hour bands"]
  T3["Tier 3 summaries: 6 hour buckets"]
  Band4["closed 1 day bands"]
  T4["Tier 4 summaries: daily buckets"]
  Idle["PerceptionLoop idle callback"]
  Read["GET /situation read"]
  Consolidate["summarize.consolidate_closed_bands"]
  SituationSummaries["summarize.situation_summaries"]
  Compose["situation.compose_situation"]
  Render["JSON or text digest"]
  PruneRaw["VisionDB.prune: keep recent rows, protect unconsolidated T1, hard limit 500"]
  PruneSummaries["prune_summaries retention: T1 12, T2 26, T3 12, T4 14"]
  Forgotten["forgotten from live digest and DB"]
  Commit --> T0
  Commit --> Stable
  T0 --> Recent
  T0 --> Band1
  Band1 --> T1
  T1 --> Band2
  Band2 --> T2
  T2 --> Band3
  Band3 --> T3
  T3 --> Band4
  Band4 --> T4
  Idle --> Consolidate
  Consolidate --> T1
  Consolidate --> T2
  Consolidate --> T3
  Consolidate --> T4
  Read --> SituationSummaries
  SituationSummaries --> T1
  SituationSummaries --> T2
  SituationSummaries --> T3
  SituationSummaries --> T4
  Recent --> Compose
  Stable --> Compose
  Stale --> Compose
  SituationSummaries --> Compose
  Compose --> Render
  T0 --> PruneRaw
  T1 --> PruneSummaries
  T2 --> PruneSummaries
  T3 --> PruneSummaries
  T4 --> PruneSummaries
  PruneRaw --> Forgotten
  PruneSummaries --> Forgotten
```

Tier 0 is the SQLite `frames` table plus `observations` table in `db.py`;
`observations.human_note` can hold a correction stamped onto a past record.
Tier 1 summarizes raw observations in closed 10 minute buckets, tier 2
summarizes tier 1 into hourly buckets, tier 3 summarizes tier 2 into 6 hour
buckets, and tier 4 summarizes tier 3 into daily buckets. `/situation` includes
recent raw changes and the newest populated summary bands: up to 3 tier-1
bands, 2 tier-2 bands, and 1 each for tiers 3 and 4.

LLM summaries are scheduled only when the scene is idle; otherwise reads return
an instant extractive fallback. `stable_seconds` is confirmed stability: it
grows only from successful captures and stops being live when the camera goes
stale. The default raw change window is `VISION_MAX_CHANGES=50`, with protected
unconsolidated tier-1 rows and a hard limit of 500 rows. Summary retention is
`TIER_RETENTION`: tier 1 keeps 12, tier 2 keeps 26, tier 3 keeps 12, and tier 4
keeps 14, giving the coarsest tier roughly a two-week horizon.

### Consumption And Feedback

The memory is useful only when agents can consume it cheaply and humans can
correct it when it is wrong. The diagram shows the prompt hook, `POST /look`,
keyword watches, change narration, and the correction backchannel.

```mermaid
flowchart LR
  subgraph Worker["vision-worker FastAPI"]
    Situation["GET /situation?format=text"]
    Look["POST /look"]
    WatchAPI["POST /watches"]
    CorrectionAPI["POST /correction"]
    OnObservation["_on_observation callback"]
  end
  subgraph Agent["coding or conversational agent"]
    Hook["scripts/situation-context-hook.sh"]
    Context["LLM context"]
    UserAsk["user asks what is visible"]
    UserFix["user corrects a camera claim"]
  end
  subgraph Alerts["alert and narration path"]
    Registry["WatchRegistry keyword match"]
    Narrator["ChangeNarrator"]
    Webhook["WebhookAlertSink POST JSON"]
    Speaker["m12_alert_speaker.py :8096 /alert"]
    Kokoro["Kokoro TTS WAV"]
    Audio["POST /api/headroom/audio with X-Headroom-Auth"]
    Echo["M12 Echo Base voice"]
  end
  subgraph Feedback["correction memory"]
    CorrMem["corrections.py scene-bound in-memory note"]
    DBNote["observations.human_note + summary invalidation"]
    Advisory["Pipeline.correction_provider"]
    Prompt["DiffusionGemmaClient correction advisory"]
  end
  Situation --> Hook
  Hook --> Context
  UserAsk --> Look
  Look --> Context
  WatchAPI --> Registry
  OnObservation --> Registry
  OnObservation --> Narrator
  Registry --> Webhook
  Narrator --> Webhook
  Webhook --> Speaker
  Speaker --> Kokoro
  Kokoro --> Audio
  Audio --> Echo
  UserFix --> CorrectionAPI
  CorrectionAPI --> CorrMem
  CorrectionAPI --> DBNote
  CorrMem --> Situation
  DBNote --> Situation
  CorrMem --> Advisory
  Advisory -- "VISION_CORRECTION_TO_MODEL=1" --> Prompt
  Prompt --> Look
```

Key details: the hook is opt-in through `MH_SITUATION_INJECT=1`, stores the
`X-Situation-Watermark` header per session, and escalates from a one-line
presence header to a full block only after salient events. `POST /look` captures
a fresh frame; default `store=1` sends it through the normal pipeline, while
`store=0` is ephemeral. Watches are keyword-only today; `kind="enum"` returns
501. `WatchRegistry.evaluate()` uses NFKC normalization and case folding over
overview, OCR, and change text.

`ChangeNarrator` skips low-confidence, baseline, no-change, and too-short lines.
`WebhookAlertSink` posts `{"text": ..., "watch": ...}` to the configured
webhook; the live stack uses `http://127.0.0.1:8096/alert`. The speaker bridge
then synthesizes Kokoro audio and sends WAV bytes to the M12
`/api/headroom/audio` endpoint with `X-Headroom-Auth`.

`POST /correction` rejects requests before any scene exists. Active corrections
are in-memory and scene-bound: they retire on a committed scene change, hash
drift beyond `VISION_CORRECTION_HASH_DRIFT`, or `VISION_CORRECTION_TTL_S`.
The endpoint also stamps `observations.human_note` onto the anchored record and
invalidates summaries that contain it. With `VISION_CORRECTION_TO_MODEL=1`, the
freshest active correction becomes a separate "may be stale" advisory in the
diffusiongemma prompt.

### Ops Quick Reference

Use the reboot-safe stack launcher from the repository root:

    ./scripts/run-vision-stack.sh --check
    ./scripts/run-vision-stack.sh

`--check` starts nothing. It verifies the persistent env file, M12 discovery,
diffusiongemma health, the vision-worker health endpoint, and whether the M12
alert speaker port is already open. The launcher starts or reuses diffusiongemma
vLLM, `vision-worker`, and the M12 alert speaker bridge. It does not start
Voxtral or any ASR path; the operator stack owns ASR.

For live configuration and the environment-variable table, use
[vision-worker/README.md](../../vision-worker/README.md#key-environment-variables).
That README also has the full-stack smoke checklist and the `--check` notes.

Useful health probes after the stack starts:

    curl -s http://127.0.0.1:8095/healthz
    curl -s http://127.0.0.1:8095/situation
    curl -s -X POST http://127.0.0.1:8095/look

Keep the safety boundary visible in agent-facing behavior: this subsystem is
informational and assistive. It samples slowly and runs over the network, so it
must not be used for driving, street crossing, or other safety-critical alerts.
