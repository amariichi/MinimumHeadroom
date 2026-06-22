"""Build the read-only "situation digest" returned by GET /situation.

The digest is a small JSON document that lets the conversational LLM stay in
sync with the camera cheaply: what the camera sees *now*, how many seconds that
view has been *stable* (unchanged), and a multi-resolution history (recent raw
changes plus, from M2 on, progressively coarser summaries). Reading it never
runs the vision model, so the LLM can read it every turn for free.

`compose_situation` is a pure assembly function: it takes the already-fetched
latest observation, the two perception timestamps, the recent change list, and
any summaries, then shapes the public JSON. It performs no I/O and runs no
model, which makes it trivial to unit-test with a controlled clock.
"""

from __future__ import annotations

from datetime import datetime, timezone

from .model_client import looks_like_no_change


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt is not None else None


def _parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO-8601 timestamp, tolerating naive strings (assumed UTC)."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def compose_situation(
    *,
    now: datetime,
    observing: bool,
    latest: dict | None,
    last_change_at: datetime | None,
    last_observed_at: datetime | None,
    recent: list[dict],
    summaries: list[dict] | None = None,
) -> dict:
    """Assemble the situation digest.

    `now` is the current UTC time. `observing` is whether the perception loop is
    running. `latest` is `VisionDB.latest()` (or None when nothing seen yet).
    `last_change_at`/`last_observed_at` are the in-memory perception timestamps;
    either may be None right after a restart. `recent` is `recent_changes(n)`
    (newest first). `summaries` are the tiered digests (empty until M2).

    `stable_seconds` is how long the current scene has held. The reference clock
    is `now` while the loop is observing (so the value grows smoothly on each
    re-read of a still scene, and over-claims by at most one poll interval), but
    falls back to `last_observed_at` when the loop is stopped so we never claim
    stability for a period we did not actually watch.
    """
    summaries = list(summaries or [])
    if latest is None:
        return {
            "now": _iso(now),
            "observing": observing,
            "current": None,
            "recent": [],
            "summaries": summaries,
        }

    # When the current scene began. Prefer the in-memory commit time; fall back
    # to the latest row's created_at so a freshly-restarted worker still reports
    # a sane (conservative) duration instead of nothing.
    changed_at = last_change_at or _parse_iso(latest.get("created_at"))

    if observing or last_observed_at is None:
        reference = now
    else:
        reference = last_observed_at

    stable_seconds: int | None = None
    if changed_at is not None:
        stable_seconds = max(0, int((reference - changed_at).total_seconds()))

    current = {
        "overview": latest.get("overview", ""),
        "is_text": bool(latest.get("is_text", False)),
        "ocr": latest.get("ocr_full", ""),
        "changed_at": _iso(changed_at),
        "confirmed_at": _iso(last_observed_at),
        "stable_seconds": stable_seconds,
    }

    recent_out = [
        {
            "at": r.get("created_at"),
            "overview": r.get("overview", ""),
            "change": r.get("change_from_prev", ""),
        }
        for r in recent
    ]

    return {
        "now": _iso(now),
        "observing": observing,
        "current": current,
        "recent": recent_out,
        "summaries": summaries,
    }


#: How a summarized tier is labelled in the rendered text block (by coarseness).
_TIER_LABELS = {1: "直近", 2: "1時間", 3: "6時間", 4: "1日"}

#: Kept short so it costs few tokens when injected on every conversational turn.
_TEXT_DISCLAIMER = "（情報提供のみ・安全用途不可）"


def humanize_seconds(seconds: int | None) -> str:
    """A compact Japanese duration: 約40秒 / 約3分 / 約2時間 / 約1日."""
    if seconds is None:
        return "不明"
    if seconds < 90:
        return f"約{seconds}秒"
    minutes = seconds // 60
    if minutes < 90:
        return f"約{minutes}分"
    hours = minutes // 60
    if hours < 36:
        return f"約{hours}時間"
    return f"約{hours // 24}日"


def render_situation_text(digest: dict) -> str:
    """Render the situation digest as a compact Japanese text block.

    This is what gets injected into the conversational LLM's context each turn
    (Design B) so its understanding never drifts from the camera. Deliberately
    terse to keep the per-turn token cost tiny.
    """
    current = digest.get("current")
    if not current:
        return f"[カメラ] まだ観測がありません。{_TEXT_DISCLAIMER}"

    observing = digest.get("observing")
    head = "観測中" if observing else "観測停止中"
    stable = humanize_seconds(current.get("stable_seconds"))
    lines = [f"[カメラの状況] {head}"]
    overview = current.get("overview") or "(不明)"
    line = f"現在: {overview}（{stable} 変化なし）"
    if current.get("is_text") and current.get("ocr"):
        line += f" / 表示テキスト: {current['ocr']}"
    lines.append(line)

    recent = digest.get("recent") or []
    if recent:
        # Skip baseline / "nothing changed" markers — they are not real changes
        # and only add noise to the injected context.
        changes = [
            r["change"]
            for r in recent
            if r.get("change") and not looks_like_no_change(r["change"])
        ][:3]
        if changes:
            lines.append("直近の変化: " + " / ".join(changes))

    for s in digest.get("summaries") or []:
        label = _TIER_LABELS.get(s.get("level"), f"L{s.get('level')}")
        text = (s.get("text") or "").strip()
        if text:
            lines.append(f"{label}: {text}")

    lines.append(_TEXT_DISCLAIMER)
    return "\n".join(lines)
