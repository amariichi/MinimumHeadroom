"""Human correction backchannel: ephemeral, scene-bound notes.

The vision pipeline is one-directional — the M12 camera and diffusiongemma
perceive, the worker digests, and the conversational LLM reads — with no path
back. So when the model mislabels something (the worked example: an ambulance's
flashing red beacon read as a lit "red traffic light") the user can tell the
LLM, but nothing carries that correction upstream, and both the per-turn
injected digest and the captioner's own "previous overview" prompt keep
re-asserting the misread.

A *correction* is a short note the user-facing LLM posts to the worker that
says, in effect, "a human clarified X about the scene the camera is looking at
right now." It is deliberately not permanent: it is anchored to the scene it was
made about and retired the moment that scene is gone. `active_corrections` is a
pure function (no I/O, no clock of its own) so it is trivially unit-testable.

A correction is retired when ANY of the following holds, evaluated against the
live pipeline state at read time:

1. A real scene change committed after it was made (`current_change_at` is newer
   than the correction's `anchor_change_at`). This is the primary path, and in
   walking/moving use it is the common one.
2. The perceptual (average) hash drifted past `drift_threshold` versus the
   anchor, even if the model narrated "no change". This is an *independent*
   backstop, so a correction can never suppress the very signal that should
   retire it — important once a correction is also fed to the captioner (M5b),
   which could otherwise be coaxed into reporting "no change" indefinitely.
3. A wall-clock cap elapsed (`now >= expires_at`). Last-resort backstop; for
   walking, (1)/(2) almost always fire first.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .imaging import hamming


def make_correction(
    *,
    correction_id: int,
    text: str,
    now: datetime,
    anchor_change_at: datetime | None,
    anchor_hash: int | None,
    ttl_s: float,
) -> dict:
    """Build a correction record anchored to the current scene.

    `anchor_change_at` is the pipeline's `last_change_at` (when the current scene
    was committed) and `anchor_hash` its `last_visual_hash` (the avg-hash of the
    most recent frame) at the moment the user corrected. `ttl_s` sets the
    wall-clock cap (`expires_at = now + ttl_s`).
    """
    return {
        "id": correction_id,
        "text": text,
        "created_at": now,
        "anchor_change_at": anchor_change_at,
        "anchor_hash": anchor_hash,
        "expires_at": now + timedelta(seconds=ttl_s),
    }


def active_corrections(
    corrections: list[dict],
    *,
    now: datetime,
    current_change_at: datetime | None,
    current_hash: int | None,
    drift_threshold: int,
    stale_soon_fraction: float = 0.8,
) -> list[dict]:
    """Return the still-live corrections, newest first.

    Each returned item is a shallow copy of the stored record with two derived
    fields added for rendering: `age_seconds` (how long ago it was made) and
    `stale_soon` (True once it has used `stale_soon_fraction` of its lifetime,
    so the LLM can re-confirm with the user before it lapses — M5c).
    """
    out: list[dict] = []
    for c in corrections:
        # (3) wall-clock cap.
        if now >= c["expires_at"]:
            continue
        # (1) a real change committed after this correction was made.
        anchor_change = c.get("anchor_change_at")
        if (
            anchor_change is not None
            and current_change_at is not None
            and current_change_at > anchor_change
        ):
            continue
        # (2) perceptual-hash drift, independent of the model's narrative.
        anchor_hash = c.get("anchor_hash")
        if (
            anchor_hash is not None
            and current_hash is not None
            and hamming(anchor_hash, current_hash) > drift_threshold
        ):
            continue

        age_seconds = max(0, int((now - c["created_at"]).total_seconds()))
        ttl_total = (c["expires_at"] - c["created_at"]).total_seconds()
        stale_soon = ttl_total > 0 and age_seconds >= stale_soon_fraction * ttl_total
        out.append({**c, "age_seconds": age_seconds, "stale_soon": stale_soon})

    out.sort(key=lambda c: c["age_seconds"])
    return out
