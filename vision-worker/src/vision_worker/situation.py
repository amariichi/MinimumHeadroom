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


def _clock_tag(digest: dict) -> str:
    now = _parse_iso(digest.get("now"))
    if now is None:
        now = datetime.now(timezone.utc)
    return now.astimezone().strftime("%H:%M")


def situation_state_token(digest: dict) -> str:
    """Comparable observing/stale state for salience gating."""
    current = digest.get("current") or {}
    observing = bool(digest.get("observing"))
    stale = bool(current.get("stale"))
    return f"observing={int(observing)};stale={int(stale)}"


def salience_reasons(
    digest: dict,
    *,
    since: datetime | None,
    corrections: list[dict] | None = None,
    state_changed_at: datetime | None = None,
) -> list[str]:
    """Return why a `since` request should receive the full situation block.

    No `since` means the legacy full-block behavior is handled by the caller.
    Active corrections deliberately count as salient for as long as they are
    live, because the human note and stale-soon nudge must keep reaching the
    conversational model until the correction retires.
    """
    if since is None:
        return []

    reasons: list[str] = []
    current = digest.get("current") or {}
    changed_at = _parse_iso(current.get("changed_at"))
    if changed_at is not None and changed_at > since:
        reasons.append("scene_change")

    if corrections:
        reasons.append("correction")

    if state_changed_at is not None and state_changed_at > since:
        reasons.append("state")

    narration = digest.get("last_narration")
    if isinstance(narration, dict):
        narrated_at = _parse_iso(narration.get("at"))
        if narrated_at is not None and narrated_at > since:
            reasons.append("narration")

    return reasons


def compose_situation(
    *,
    now: datetime,
    observing: bool,
    latest: dict | None,
    last_change_at: datetime | None,
    last_observed_at: datetime | None,
    recent: list[dict],
    summaries: list[dict] | None = None,
    stale_after_s: float = 30.0,
) -> dict:
    """Assemble the situation digest.

    `now` is the current UTC time. `observing` is whether the perception loop is
    running. `latest` is `VisionDB.latest()` (or None when nothing seen yet).
    `last_change_at`/`last_observed_at` are the in-memory perception timestamps;
    either may be None right after a restart. `recent` is `recent_changes(n)`
    (newest first). `summaries` are the tiered digests.

    `stable_seconds` is *confirmed* stability: it is measured from the last
    actual observation (`last_observed_at`), so it stops growing the instant
    frames stop arriving — a disconnected camera or a stopped loop never inflates
    it. Without any observation this session it is `null` rather than a
    misleading large number derived from a stale database row. `stale` is true
    when the loop is supposedly observing but no fresh frame has arrived for
    longer than `stale_after_s` (the camera is unreachable), so a reader knows
    the figures are not currently live.
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
    # to the latest row's created_at so a freshly-restarted worker still knows
    # when the scene last changed.
    changed_at = last_change_at or _parse_iso(latest.get("created_at"))

    confirmed_age_seconds: int | None = None
    stable_seconds: int | None = None
    if last_observed_at is not None:
        confirmed_age_seconds = max(0, int((now - last_observed_at).total_seconds()))
        if changed_at is not None:
            stable_seconds = max(0, int((last_observed_at - changed_at).total_seconds()))
    stale = bool(
        observing
        and confirmed_age_seconds is not None
        and confirmed_age_seconds > stale_after_s
    )

    # How long ago the shown scene is — when we last had eyes on it (a Mode B
    # confirmation, else when the change / one-shot was committed). Lets a reader
    # say "last seen 3 minutes / 2 hours / 1 day ago" for a non-live scene.
    as_of_ref = last_observed_at or changed_at
    as_of_age_seconds = (
        max(0, int((now - as_of_ref).total_seconds())) if as_of_ref is not None else None
    )

    current = {
        "overview": latest.get("overview", ""),
        "is_text": bool(latest.get("is_text", False)),
        "ocr": latest.get("ocr_full", ""),
        "changed_at": _iso(changed_at),
        "confirmed_at": _iso(last_observed_at),
        "confirmed_age_seconds": confirmed_age_seconds,
        "as_of_age_seconds": as_of_age_seconds,
        "stable_seconds": stable_seconds,
        "stale": stale,
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

#: The rendered block can be injected every conversational turn, so historical
#: summary lines stay bounded even when several closed bands are returned.
_SUMMARY_LINE_LIMIT = 5
_T1_RENDER_LIMIT = 3

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



def _render_summary_lines(summaries: list[dict]) -> list[str]:
    tier1_texts: list[str] = []
    other_lines: list[str] = []
    for s in summaries:
        text = (s.get("text") or "").strip()
        if not text:
            continue
        level = s.get("level")
        if level == 1:
            tier1_texts.append(text)
            continue
        label = _TIER_LABELS.get(level, f"L{level}")
        other_lines.append(f"{label}: {text}")

    lines: list[str] = []
    if tier1_texts:
        joined = " ← ".join(tier1_texts[:_T1_RENDER_LIMIT])
        lines.append(f"{_TIER_LABELS[1]}: {joined}")
    lines.extend(other_lines)
    return lines[:_SUMMARY_LINE_LIMIT]


def render_situation_presence_line(digest: dict) -> str:
    """Render the every-turn low-cost Design B presence line."""
    stamp = _clock_tag(digest)
    current = digest.get("current")
    if not current:
        return f"[カメラ {stamp}] まだ観測がありません（詳細はGET /situation）"

    overview = (current.get("overview") or "(不明)").strip()
    observing = bool(digest.get("observing"))
    stale = bool(current.get("stale"))
    stable_seconds = current.get("stable_seconds")

    if observing and not stale and stable_seconds is not None:
        status = f"{humanize_seconds(stable_seconds)}変化なし"
    elif stale:
        age = current.get("as_of_age_seconds")
        prefix = f"{humanize_seconds(age)}前・" if age is not None else ""
        status = f"{prefix}カメラ応答なし"
    elif not observing:
        age = current.get("as_of_age_seconds")
        status = f"{humanize_seconds(age)}前" if age is not None else "観測停止中"
    else:
        status = "観測中"

    return f"[カメラ {stamp}] {overview}（{status}・詳細はGET /situation）"


def render_situation_text(digest: dict, corrections: list[dict] | None = None) -> str:
    """Render the situation digest as a compact Japanese text block.

    This is what gets injected into the conversational LLM's context each turn
    (Design B) so its understanding never drifts from the camera. Deliberately
    terse to keep the per-turn token cost tiny.

    `corrections` are the still-active human corrections (from
    `corrections.active_corrections`, newest first). When present they are
    rendered right after the current-scene line so the LLM weighs the human
    note against what the camera reports and stops repeating a misread. While
    the camera is unreachable (`stale`) the note cannot be re-verified, so it is
    flagged as unconfirmed; near the end of its lifetime a re-confirmation nudge
    is added so the LLM can ask the user before it lapses (M5c).
    """
    stamp = _clock_tag(digest)
    current = digest.get("current")
    if not current:
        return f"[カメラ {stamp}] まだ観測がありません。{_TEXT_DISCLAIMER}"

    observing = digest.get("observing")
    stale = current.get("stale")
    stable_seconds = current.get("stable_seconds")
    # "Live" means we are continuously observing and a fresh frame confirmed the
    # scene moments ago. Anything else is the LAST SEEN scene, labelled as such
    # with how long ago it was — so the reader never mistakes old for current.
    live = bool(observing) and not stale and stable_seconds is not None

    if stale:
        head = "⚠カメラ応答なし"
    elif observing:
        head = "観測中"
    else:
        head = "観測停止中"
    lines = [f"[カメラの状況 {stamp}] {head}"]

    overview = current.get("overview") or "(不明)"
    if live:
        line = f"現在: {overview}（{humanize_seconds(stable_seconds)} 変化なし）"
    else:
        parts = []
        age = current.get("as_of_age_seconds")
        if age is not None:
            parts.append(f"{humanize_seconds(age)}前")
        if stale:
            parts.append("カメラ応答なし")
        paren = f"（{'、'.join(parts)}）" if parts else ""
        line = f"最後に見えた光景: {overview}{paren}"
    if current.get("is_text") and current.get("ocr"):
        line += f" / 表示テキスト: {current['ocr']}"
    lines.append(line)

    # Human corrections, scene-bound. Rendered right after the current scene so
    # the LLM weighs them against it. The freshest one or two only, to stay terse.
    active = corrections or []
    if active:
        unverified = bool(stale)
        nudge = False
        for c in active[:2]:
            text = (c.get("text") or "").strip()
            if not text:
                continue
            age = humanize_seconds(c.get("age_seconds"))
            suffix = "・カメラ応答なし・未確認" if unverified else "・現シーン限定"
            lines.append(f"[人の補足] {text}（{age}前にユーザーが訂正{suffix}）")
            if c.get("stale_soon") and not unverified:
                nudge = True
        if nudge:
            lines.append("（↑まだ有効か、必要ならユーザーに確認してください）")

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

    lines.extend(_render_summary_lines(digest.get("summaries") or []))

    lines.append(_TEXT_DISCLAIMER)
    return "\n".join(lines)
