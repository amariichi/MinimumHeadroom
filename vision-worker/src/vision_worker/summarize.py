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
from datetime import datetime, timedelta

#: Tier-1 band geometry. "Recent" (the last few minutes) stays raw in the
#: digest's `recent` list; tier 1 is the first *summarized* band behind it,
#: covering [now-10min, now-3min] aligned to whole minutes so repeated reads
#: within the same minute resolve to the same cache key.
T1_LAG_MIN = 3
T1_SPAN_MIN = 7  # 10 - 3

_INSTRUCTION_JA = (
    "次の時系列の変化ログを、1〜2文の自然な日本語で要約してください。"
    "箇条書きや前置きは付けず、要約文だけを返してください。"
)


def floor_minute(dt: datetime) -> datetime:
    return dt.replace(second=0, microsecond=0)


def t1_band(now: datetime) -> tuple[datetime, datetime]:
    """The [now-10min, now-3min] tier-1 window, aligned to whole minutes."""
    end = floor_minute(now) - timedelta(minutes=T1_LAG_MIN)
    start = end - timedelta(minutes=T1_SPAN_MIN)
    return start, end


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


def situation_summaries(db, summarizer: Summarizer, now: datetime, *, idle: bool) -> list[dict]:
    """Build the `summaries` list for GET /situation (tier 1 only in M2).

    Returns the cached LLM summary for the tier-1 band if present; otherwise the
    instant extractive summary, and — only when the scene is idle — schedules the
    LLM summary to be computed and cached in the background. An empty band (no
    changes 3-10 minutes ago) yields no entry.
    """
    start, end = t1_band(now)
    start_iso, end_iso = start.isoformat(), end.isoformat()

    cached = db.get_summary(1, start_iso)
    if cached:
        return [
            _entry(
                1,
                cached["period_start"],
                cached["period_end"],
                cached["text"],
                cached["source_count"],
                pending=False,
            )
        ]

    changes = db.changes_between(start_iso, end_iso)
    if not changes:
        return []

    pending = summarizer.enabled and idle
    if pending:
        summarizer.schedule(
            db,
            level=1,
            period_start_iso=start_iso,
            period_end_iso=end_iso,
            changes=changes,
        )
    return [_entry(1, start_iso, end_iso, extractive_summary(changes), len(changes), pending=pending)]


def build_summarizer(settings) -> Summarizer:
    return Summarizer(
        base_url=settings.model_url,
        model_name=settings.model_name,
        max_tokens=settings.summary_max_tokens,
        enabled=settings.summary_enabled,
    )
