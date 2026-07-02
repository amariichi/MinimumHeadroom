"""SQLite-backed rolling visual memory.

Two tables: `frames` (one row per stored image with its on-disk paths) and
`observations` (one row per change point: full OCR, overview, change summary).
"latest" and "previous" are simply the two most recent observations; the
rolling change window is the most recent N observations (default 50). Pruning
deletes older observations and any frames they no longer reference, returning
the orphaned file paths so the caller can delete them from disk.

Connections are opened per call so the database is safe to share between the
HTTP server process and a separate frame-replay process (SQLite file locking).
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Iterator

from .records import Observation

_SCHEMA = """
CREATE TABLE IF NOT EXISTS frames (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_at TEXT NOT NULL,
    phash TEXT,
    full_path TEXT NOT NULL,
    thumb_path TEXT,
    width INTEGER,
    height INTEGER
);
CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    frame_id INTEGER NOT NULL REFERENCES frames(id),
    is_text INTEGER NOT NULL,
    ocr_full TEXT NOT NULL DEFAULT '',
    overview TEXT NOT NULL DEFAULT '',
    change_from_prev TEXT NOT NULL DEFAULT '',
    human_note TEXT,
    model TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    low_confidence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_id ON observations(id DESC);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at);
CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level INTEGER NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    source_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(level, period_start)
);
CREATE INDEX IF NOT EXISTS idx_summaries_level ON summaries(level, period_start DESC);
"""

_SELECT = """
SELECT o.id AS obs_id, o.frame_id, o.is_text, o.ocr_full, o.overview,
       o.change_from_prev, o.human_note, o.model, o.latency_ms, o.low_confidence, o.created_at,
       f.captured_at, f.width, f.height
FROM observations o
JOIN frames f ON f.id = o.frame_id
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _to_public(row: sqlite3.Row) -> dict:
    """Public-facing record. Deliberately omits on-disk paths; callers fetch the
    image via the /frame/{id} endpoint instead."""
    return {
        "obs_id": row["obs_id"],
        "frame_id": row["frame_id"],
        "is_text": bool(row["is_text"]),
        "overview": row["overview"],
        "ocr_full": row["ocr_full"],
        "change_from_prev": row["change_from_prev"],
        "human_note": row["human_note"],
        "low_confidence": bool(row["low_confidence"]),
        "model": row["model"],
        "latency_ms": row["latency_ms"],
        "captured_at": row["captured_at"],
        "created_at": row["created_at"],
        "width": row["width"],
        "height": row["height"],
    }


class VisionDB:
    def __init__(self, path: str) -> None:
        self.path = path
        parent = os.path.dirname(os.path.abspath(path))
        os.makedirs(parent, exist_ok=True)
        with self._conn() as conn:
            conn.executescript(_SCHEMA)
            columns = {
                r["name"]
                for r in conn.execute("PRAGMA table_info(observations)").fetchall()
            }
            if "human_note" not in columns:
                conn.execute("ALTER TABLE observations ADD COLUMN human_note TEXT")

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=5.0)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def insert_frame(
        self,
        captured_at: str,
        phash: str | None,
        full_path: str,
        thumb_path: str | None,
        width: int,
        height: int,
    ) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO frames(captured_at, phash, full_path, thumb_path, width, height)"
                " VALUES(?, ?, ?, ?, ?, ?)",
                (captured_at, phash, full_path, thumb_path, width, height),
            )
            return int(cur.lastrowid)

    def insert_observation(self, frame_id: int, obs: Observation) -> int:
        with self._conn() as conn:
            cur = conn.execute(
                "INSERT INTO observations(frame_id, is_text, ocr_full, overview,"
                " change_from_prev, model, latency_ms, low_confidence, created_at)"
                " VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    frame_id,
                    int(obs.is_text),
                    obs.ocr_full,
                    obs.overview,
                    obs.change_from_prev,
                    obs.model,
                    obs.latency_ms,
                    int(obs.low_confidence),
                    _now(),
                ),
            )
            return int(cur.lastrowid)

    def _one(self, offset: int) -> dict | None:
        with self._conn() as conn:
            row = conn.execute(
                _SELECT + " ORDER BY o.id DESC LIMIT 1 OFFSET ?", (offset,)
            ).fetchone()
            return _to_public(row) if row else None

    def latest(self) -> dict | None:
        return self._one(0)

    def previous(self) -> dict | None:
        return self._one(1)

    def recent_changes(self, n: int = 50) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                _SELECT + " ORDER BY o.id DESC LIMIT ?", (n,)
            ).fetchall()
            return [_to_public(r) for r in rows]

    def changes_between(self, start_iso: str, end_iso: str) -> list[dict]:
        """Change observations whose commit time is in [start_iso, end_iso).

        Used by the hierarchical summarizer to gather one time band. Timestamps
        are UTC ISO-8601 with the same offset everywhere, so lexicographic
        comparison is a correct chronological comparison. Newest first.
        """
        with self._conn() as conn:
            rows = conn.execute(
                _SELECT
                + " WHERE o.created_at >= ? AND o.created_at < ?"
                + " ORDER BY o.id DESC",
                (start_iso, end_iso),
            ).fetchall()
            return [_to_public(r) for r in rows]

    def stamp_human_note_at_or_before(self, anchor_iso: str, note: str) -> dict | None:
        """Attach a human note to the newest observation at or before anchor_iso."""
        with self._conn() as conn:
            row = conn.execute(
                _SELECT
                + " WHERE o.created_at <= ?"
                + " ORDER BY o.created_at DESC, o.id DESC LIMIT 1",
                (anchor_iso,),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                "UPDATE observations SET human_note = ? WHERE id = ?",
                (note, row["obs_id"]),
            )
            updated = conn.execute(
                _SELECT + " WHERE o.id = ?",
                (row["obs_id"],),
            ).fetchone()
            return _to_public(updated) if updated else None

    def upsert_summary(
        self,
        level: int,
        period_start: str,
        period_end: str,
        text: str,
        source_count: int,
    ) -> None:
        """Insert or replace the summary for a (level, period_start) band."""
        with self._conn() as conn:
            conn.execute(
                "INSERT INTO summaries(level, period_start, period_end, text,"
                " source_count, created_at) VALUES(?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(level, period_start) DO UPDATE SET"
                " period_end=excluded.period_end, text=excluded.text,"
                " source_count=excluded.source_count, created_at=excluded.created_at",
                (level, period_start, period_end, text, source_count, _now()),
            )

    def get_summary(self, level: int, period_start: str) -> dict | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT level, period_start, period_end, text, source_count, created_at"
                " FROM summaries WHERE level = ? AND period_start = ?",
                (level, period_start),
            ).fetchone()
            return dict(row) if row else None

    def recent_summaries(self, level: int, n: int = 10) -> list[dict]:
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT level, period_start, period_end, text, source_count, created_at"
                " FROM summaries WHERE level = ? ORDER BY period_start DESC LIMIT ?",
                (level, n),
            ).fetchall()
            return [dict(r) for r in rows]

    def summaries_between(self, level: int, start_iso: str, end_iso: str) -> list[dict]:
        """Summaries of a tier whose period_start is in [start_iso, end_iso).

        The input a higher tier consolidates: e.g. the hour tier (level 2) reads
        the ~six ten-minute (level 1) summaries inside its hour. Newest first.
        """
        with self._conn() as conn:
            rows = conn.execute(
                "SELECT level, period_start, period_end, text, source_count, created_at"
                " FROM summaries WHERE level = ? AND period_start >= ? AND period_start < ?"
                " ORDER BY period_start DESC",
                (level, start_iso, end_iso),
            ).fetchall()
            return [dict(r) for r in rows]

    def prune_summaries(self, level: int, keep: int) -> None:
        """Keep only the `keep` most recent summaries (by period_start) of a tier."""
        with self._conn() as conn:
            ids = [
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM summaries WHERE level = ?"
                    " ORDER BY period_start DESC LIMIT ?",
                    (level, keep),
                ).fetchall()
            ]
            if ids:
                placeholders = ",".join("?" * len(ids))
                conn.execute(
                    f"DELETE FROM summaries WHERE level = ? AND id NOT IN ({placeholders})",
                    (level, *ids),
                )
            else:
                conn.execute("DELETE FROM summaries WHERE level = ?", (level,))

    def delete_summaries_containing(self, ts_iso: str) -> int:
        """Delete cached summaries at every tier whose closed band contains ts."""
        with self._conn() as conn:
            cur = conn.execute(
                "DELETE FROM summaries WHERE period_start <= ? AND period_end > ?",
                (ts_iso, ts_iso),
            )
            return int(cur.rowcount)

    def search(self, query: str, limit: int = 50) -> list[dict]:
        like = f"%{query}%"
        with self._conn() as conn:
            rows = conn.execute(
                _SELECT
                + " WHERE o.ocr_full LIKE ? OR o.overview LIKE ?"
                + " ORDER BY o.id DESC LIMIT ?",
                (like, like, limit),
            ).fetchall()
            return [_to_public(r) for r in rows]

    def frame_path(self, frame_id: int) -> str | None:
        with self._conn() as conn:
            row = conn.execute(
                "SELECT full_path FROM frames WHERE id = ?", (frame_id,)
            ).fetchone()
            return row["full_path"] if row else None

    def _unconsolidated_t1_observation_ids(
        self,
        conn: sqlite3.Connection,
        *,
        now: datetime,
        bucket: timedelta,
        retention_bands: int,
    ) -> set[int]:
        open_start = datetime.fromtimestamp(
            (int(now.timestamp()) // int(bucket.total_seconds())) * int(bucket.total_seconds()),
            tz=timezone.utc,
        )
        protected: set[int] = set()
        end = open_start
        for _ in range(max(0, retention_bands)):
            start = end - bucket
            start_iso, end_iso = start.isoformat(), end.isoformat()
            cached = conn.execute(
                "SELECT 1 FROM summaries WHERE level = 1 AND period_start = ?",
                (start_iso,),
            ).fetchone()
            if cached is None:
                rows = conn.execute(
                    "SELECT id FROM observations WHERE created_at >= ? AND created_at < ?",
                    (start_iso, end_iso),
                ).fetchall()
                protected.update(int(r["id"]) for r in rows)
            end = start
        return protected

    def prune(
        self,
        max_changes: int = 50,
        *,
        protect_unconsolidated_t1: bool = True,
        now: datetime | None = None,
        t1_bucket: timedelta = timedelta(minutes=10),
        t1_retention_bands: int = 12,
        hard_limit: int = 500,
    ) -> list[tuple[str | None, str | None]]:
        """Keep only the most recent `max_changes` observations.

        When `protect_unconsolidated_t1` is true, older rows in closed tier-1
        bands without a cached summary are kept so background consolidation can
        still build the digest after a silent busy period. `hard_limit` bounds
        total observation growth if the summarizer stays unhealthy for a long run.

        Returns the (full_path, thumb_path) pairs of frames that became orphaned
        so the caller can delete them from disk.
        """
        with self._conn() as conn:
            keep_ids = {
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM observations ORDER BY id DESC LIMIT ?",
                    (max_changes,),
                ).fetchall()
            }
            if protect_unconsolidated_t1:
                keep_ids.update(
                    self._unconsolidated_t1_observation_ids(
                        conn,
                        now=now or datetime.now(timezone.utc),
                        bucket=t1_bucket,
                        retention_bands=t1_retention_bands,
                    )
                )
            if hard_limit > 0 and len(keep_ids) > hard_limit:
                rows = conn.execute(
                    "SELECT id FROM observations ORDER BY id DESC"
                ).fetchall()
                trimmed: set[int] = set()
                for row in rows:
                    row_id = int(row["id"])
                    if row_id in keep_ids:
                        trimmed.add(row_id)
                        if len(trimmed) >= hard_limit:
                            break
                keep_ids = trimmed
            if keep_ids:
                placeholders = ",".join("?" * len(keep_ids))
                conn.execute(
                    f"DELETE FROM observations WHERE id NOT IN ({placeholders})",
                    tuple(keep_ids),
                )
            else:
                conn.execute("DELETE FROM observations")

            orphans = conn.execute(
                "SELECT f.id, f.full_path, f.thumb_path FROM frames f"
                " LEFT JOIN observations o ON o.frame_id = f.id"
                " WHERE o.id IS NULL"
            ).fetchall()
            orphan_ids = [r["id"] for r in orphans]
            if orphan_ids:
                placeholders = ",".join("?" * len(orphan_ids))
                conn.execute(
                    f"DELETE FROM frames WHERE id IN ({placeholders})", orphan_ids
                )
            return [(r["full_path"], r["thumb_path"]) for r in orphans]

    def counts(self) -> dict:
        with self._conn() as conn:
            obs = conn.execute("SELECT COUNT(*) AS c FROM observations").fetchone()["c"]
            frames = conn.execute("SELECT COUNT(*) AS c FROM frames").fetchone()["c"]
            return {"observations": int(obs), "frames": int(frames)}
