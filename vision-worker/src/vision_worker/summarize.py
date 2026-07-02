"""Low-cost hierarchical text summarization for the situation digest (M2+).

The situation digest (GET /situation) keeps the last few minutes of change
events verbatim, but older history is condensed into progressively coarser
summaries so the conversational LLM can grasp "what happened earlier" in a few
tokens. This module produces those summaries.

`extractive_summary` is a pure, model-free fallback (counts + endpoints), so a
summary is *always* available instantly and a read never fails. `Summarizer`
produces a higher-quality one or two sentence Japanese digest by reusing the
already-loaded diffusiongemma — the SAME OpenAI-compatible server the vision
model uses, called text-only (no image), which draws from vLLM's pre-allocated
KV-cache pool and so adds no GPU VRAM. On any error/timeout it degrades to the
extractive summary.

To keep the cost negligible, the LLM summary is produced lazily and in the
background: a `/situation` read returns the instant extractive summary now and,
only while the scene is idle (stable), schedules the LLM summary to be computed
off the request thread and cached; the next read picks up the cached version.
The read itself never blocks on the model, and perception is never starved.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone

#: The pyramidal tier ladder. "Recent" (the last few minutes of raw change
#: events) stays verbatim in the digest's `recent` list — that is tier 0. Behind
#: it, history is consolidated into fixed, non-overlapping, epoch-aligned
#: wall-clock buckets, each tier coarser than the last. A tier is built by
#: summarizing the tier directly below it (tier 1 summarizes raw changes; tier 2
#: summarizes the ~six tier-1 summaries inside its hour; and so on), so every
#: summarization step has only a handful of short inputs regardless of how much
#: happened — the round-robin / RRDtool consolidation pattern.
TIER_BUCKETS: dict[int, timedelta] = {
    1: timedelta(minutes=10),
    2: timedelta(hours=1),
    3: timedelta(hours=6),
    4: timedelta(days=1),
}
MAX_LEVEL = max(TIER_BUCKETS)

#: How many summaries to retain per tier. Each cap comfortably exceeds the reach
#: of the tier above (which consolidates the previous bucket), so a higher tier
#: never finds its inputs already pruned: tier 2 (hourly) needs ~6 tier-1 of the
#: last <2 h (keep 12); tier 3 (6 h) needs ~6 tier-2 of the last <12 h (keep 26);
#: tier 4 (daily) needs ~4 tier-3 of the last <2 d (keep 12). Beyond the tier-4
#: horizon (~2 weeks) everything is dropped (a long-term diary is out of scope).
TIER_RETENTION: dict[int, int] = {1: 12, 2: 26, 3: 12, 4: 14}

#: How many recent closed bands each tier may contribute to the live situation
#: digest. This plugs the gap where content just older than the newest closed
#: T1 bucket could vanish until the coarser T2 bucket closed.
SITUATION_SUMMARY_BANDS: dict[int, int] = {1: 3, 2: 2, 3: 1, 4: 1}

_INSTRUCTION_JA = (
    "次の時系列の変化ログを、1〜2文の自然な日本語で要約してください。"
    "箇条書きや前置きは付けず、要約文だけを返してください。"
)


def bucket_start(t: datetime, bucket: timedelta) -> datetime:
    """Epoch-aligned floor of `t` to the bucket grid (UTC).

    Epoch-based flooring aligns 10-min buckets to :00/:10/…, hour buckets to the
    top of the hour, 6-hour buckets to 00/06/12/18 UTC, and day buckets to UTC
    midnight — with no daylight-saving hazards since everything is UTC.
    """
    secs = bucket.total_seconds()
    floored = (int(t.timestamp()) // int(secs)) * int(secs)
    return datetime.fromtimestamp(floored, tz=timezone.utc)


def tier_band(now: datetime, level: int) -> tuple[datetime, datetime]:
    """The newest *closed* bucket for `level`: [start, end) with end <= now.

    The currently-open bucket is `[bucket_start(now), …)`; the newest closed one
    ends exactly where the open one begins, so it is always fully in the past.
    """
    bucket = TIER_BUCKETS[level]
    open_start = bucket_start(now, bucket)
    return open_start - bucket, open_start


def closed_bands(now: datetime, level: int, n: int | None = None) -> list[tuple[datetime, datetime]]:
    """Closed buckets for `level` within its retention horizon, newest first."""
    bucket = TIER_BUCKETS[level]
    keep = TIER_RETENTION[level] if n is None else n
    end = bucket_start(now, bucket)
    bands = []
    for _ in range(max(0, keep)):
        start = end - bucket
        bands.append((start, end))
        end = start
    return bands


def _change_text(c: dict) -> str:
    return (c.get("change_from_prev") or c.get("overview") or "").strip()


def extractive_summary(changes: list[dict]) -> str:
    """Model-free digest of change records (newest first).

    Each record is a dict with `overview` and/or `change_from_prev`. Returns a
    short Japanese line; empty input yields ''.
    """
    items = [c for c in changes if _change_text(c)]
    if not items:
        return ""
    n = len(items)
    newest = _change_text(items[0])
    oldest = _change_text(items[-1])
    if n == 1:
        return newest
    if oldest == newest:
        return f"{n}件の変化: {newest}"
    return f"{n}件の変化: {oldest} → {newest}"


class Summarizer:
    """Condenses change records into one or two Japanese sentences.

    `summarize` is synchronous (used directly in tests and as the worker body).
    `schedule` runs `summarize` on a daemon thread and upserts the result into
    the DB, deduped by (level, period_start) so concurrent reads do not pile up.
    """

    def __init__(
        self,
        *,
        base_url: str,
        model_name: str,
        max_tokens: int = 80,
        timeout: float = 20.0,
        enabled: bool = True,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.enabled = enabled
        self._inflight: set[tuple[int, str]] = set()
        self._lock = threading.Lock()

    def _format_changes(self, changes: list[dict]) -> str:
        # Oldest first so the model reads the band chronologically.
        lines = []
        for c in reversed(changes):
            at = c.get("created_at") or c.get("captured_at") or c.get("at") or ""
            text = _change_text(c)
            if text:
                lines.append(f"- {at} {text}")
        return "\n".join(lines)

    def _summarize_llm(self, changes: list[dict]) -> str:
        import httpx

        body = self._format_changes(changes)
        payload = {
            "model": self.model_name,
            "messages": [{"role": "user", "content": f"{_INSTRUCTION_JA}\n\n{body}"}],
            "max_tokens": self.max_tokens,
            "temperature": 0,
        }
        resp = httpx.post(
            f"{self.base_url}/chat/completions", json=payload, timeout=self.timeout
        )
        resp.raise_for_status()
        text = resp.json()["choices"][0]["message"]["content"].strip()
        return text or extractive_summary(changes)

    def summarize(self, changes: list[dict], *, level: int = 1) -> str:
        if not changes:
            return ""
        if not self.enabled:
            return extractive_summary(changes)
        try:
            return self._summarize_llm(changes)
        except Exception:  # noqa: BLE001 - any failure degrades to extractive
            return extractive_summary(changes)

    def schedule(
        self,
        db,
        *,
        level: int,
        period_start_iso: str,
        period_end_iso: str,
        changes: list[dict],
    ) -> threading.Thread | None:
        """Compute + cache the LLM summary off the request thread.

        Returns the started Thread (tests join it), or None when disabled, empty,
        or a job for this band is already in flight.
        """
        if not self.enabled or not changes:
            return None
        key = (level, period_start_iso)
        with self._lock:
            if key in self._inflight:
                return None
            self._inflight.add(key)

        def _work() -> None:
            try:
                text = self.summarize(changes, level=level)
                if text:
                    db.upsert_summary(
                        level, period_start_iso, period_end_iso, text, len(changes)
                    )
            finally:
                with self._lock:
                    self._inflight.discard(key)

        thread = threading.Thread(target=_work, name=f"summarize-L{level}", daemon=True)
        thread.start()
        return thread


def _entry(level: int, start_iso: str, end_iso: str, text: str, count: int, *, pending: bool) -> dict:
    return {
        "level": level,
        "period_start": start_iso,
        "period_end": end_iso,
        "text": text,
        "source_count": count,
        "pending_llm": pending,
    }


def _sources_for(db, level: int, start_iso: str, end_iso: str) -> list[dict]:
    """The inputs a tier consolidates, normalised to change-record shape.

    Tier 1 reads the raw change observations in its band; every higher tier reads
    the summaries of the tier directly below it, presented as `change_from_prev`
    text so the same `extractive_summary`/`Summarizer` code handles both.
    """
    if level <= 1:
        return db.changes_between(start_iso, end_iso)
    rows = db.summaries_between(level - 1, start_iso, end_iso)
    return [{"created_at": r["period_start"], "change_from_prev": r["text"]} for r in rows]


def _consolidate_tier(db, summarizer: Summarizer, now: datetime, level: int, *, idle: bool) -> dict | None:
    """Newest-closed summary entry for one tier (cached LLM, else instant
    extractive), scheduling the LLM job when idle+uncached. None when the band
    has no source content yet."""
    start, end = tier_band(now, level)
    return _consolidate_band(db, summarizer, level, start, end, idle=idle)


def _consolidate_band(
    db,
    summarizer: Summarizer,
    level: int,
    start: datetime,
    end: datetime,
    *,
    idle: bool,
) -> dict | None:
    """Summary entry for one specific closed band."""
    start_iso, end_iso = start.isoformat(), end.isoformat()

    cached = db.get_summary(level, start_iso)
    if cached:
        return _entry(
            level, cached["period_start"], cached["period_end"],
            cached["text"], cached["source_count"], pending=False,
        )

    sources = _sources_for(db, level, start_iso, end_iso)
    if not sources:
        return None

    pending = summarizer.enabled and idle
    if pending:
        summarizer.schedule(
            db, level=level, period_start_iso=start_iso,
            period_end_iso=end_iso, changes=sources,
        )
    return _entry(level, start_iso, end_iso, extractive_summary(sources), len(sources), pending=pending)


def consolidate_closed_bands(db, summarizer: Summarizer, now: datetime) -> list[threading.Thread]:
    """Schedule uncached closed bands across the tier ladder, independent of reads.

    This is the background path used by the perception loop while idle. It only
    schedules work; `Summarizer.schedule` dedupes in-flight jobs and performs the
    normal LLM-or-extractive-fallback upsert off-thread.
    """
    threads: list[threading.Thread] = []
    for level in range(1, MAX_LEVEL + 1):
        for start, end in closed_bands(now, level):
            start_iso, end_iso = start.isoformat(), end.isoformat()
            if db.get_summary(level, start_iso):
                continue
            sources = _sources_for(db, level, start_iso, end_iso)
            if not sources:
                continue
            thread = summarizer.schedule(
                db,
                level=level,
                period_start_iso=start_iso,
                period_end_iso=end_iso,
                changes=sources,
            )
            if thread is not None:
                threads.append(thread)
    for level, keep in TIER_RETENTION.items():
        db.prune_summaries(level, keep)
    return threads


def situation_summaries(db, summarizer: Summarizer, now: datetime, *, idle: bool) -> list[dict]:
    """Build the `summaries` list for GET /situation from recent closed bands.

    Each tier contributes its newest populated closed bands (T1 up to three,
    T2 up to two, T3/T4 one each), newest first. For each band it returns the
    cached LLM summary if present, else an instant extractive summary, and —
    only while the scene is idle — schedules the LLM summary to be computed and
    cached off the request thread. The read never blocks on the model. While
    idle it also prunes each tier to its retention cap so the table stays
    bounded over a long run.
    """
    out: list[dict] = []
    for level in range(1, MAX_LEVEL + 1):
        for start, end in closed_bands(now, level, SITUATION_SUMMARY_BANDS.get(level, 1)):
            entry = _consolidate_band(db, summarizer, level, start, end, idle=idle)
            if entry is not None:
                out.append(entry)
    if idle:
        for level, keep in TIER_RETENTION.items():
            db.prune_summaries(level, keep)
    return out


def build_summarizer(settings) -> Summarizer:
    return Summarizer(
        base_url=settings.model_url,
        model_name=settings.model_name,
        max_tokens=settings.summary_max_tokens,
        enabled=settings.summary_enabled,
    )
