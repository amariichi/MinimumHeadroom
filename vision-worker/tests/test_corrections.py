from __future__ import annotations

from datetime import datetime, timedelta, timezone

from vision_worker.corrections import active_corrections, make_correction

UTC = timezone.utc
T0 = datetime(2026, 6, 25, 12, 0, 0, tzinfo=UTC)


def _corr(**kw) -> dict:
    base = dict(
        correction_id=1,
        text="赤色灯",
        now=T0,
        anchor_change_at=T0,
        anchor_hash=0,
        ttl_s=120.0,
    )
    base.update(kw)
    return make_correction(**base)


def _active(corr, *, secs, change_at=T0, current_hash=0, drift=8):
    return active_corrections(
        [corr] if isinstance(corr, dict) else corr,
        now=T0 + timedelta(seconds=secs),
        current_change_at=change_at,
        current_hash=current_hash,
        drift_threshold=drift,
    )


def test_make_correction_sets_expiry_and_anchors():
    c = _corr()
    assert c["expires_at"] == T0 + timedelta(seconds=120)
    assert c["text"] == "赤色灯"
    assert c["anchor_change_at"] == T0
    assert c["anchor_hash"] == 0


def test_active_while_scene_unchanged():
    out = _active(_corr(), secs=10)
    assert len(out) == 1
    assert out[0]["age_seconds"] == 10
    assert out[0]["stale_soon"] is False


def test_retired_by_committed_change():
    # A real change committed 5s after the correction was made.
    out = _active(_corr(), secs=10, change_at=T0 + timedelta(seconds=5))
    assert out == []


def test_retired_by_hash_drift_even_when_model_says_no_change():
    # current_change_at unchanged (model narrated "no change"), but the view
    # drifted by 9 bits (> threshold 8): the independent backstop retires it.
    drifted = (1 << 9) - 1
    out = _active(_corr(anchor_hash=0), secs=10, current_hash=drifted, drift=8)
    assert out == []


def test_kept_when_hash_drift_within_threshold():
    within = (1 << 8) - 1  # exactly 8 bits set == threshold, not greater
    out = _active(_corr(anchor_hash=0), secs=10, current_hash=within, drift=8)
    assert len(out) == 1


def test_retired_by_wall_clock_cap():
    out = _active(_corr(ttl_s=120.0), secs=121)
    assert out == []


def test_stale_soon_flag_past_80_percent():
    out = _active(_corr(ttl_s=100.0), secs=85)
    assert len(out) == 1
    assert out[0]["stale_soon"] is True


def test_newest_first_ordering():
    old = make_correction(
        correction_id=1, text="old", now=T0, anchor_change_at=T0, anchor_hash=0, ttl_s=300
    )
    new = make_correction(
        correction_id=2,
        text="new",
        now=T0 + timedelta(seconds=20),
        anchor_change_at=T0,
        anchor_hash=0,
        ttl_s=300,
    )
    out = _active([old, new], secs=30)
    assert [c["text"] for c in out] == ["new", "old"]


def test_none_anchors_only_expire_by_cap():
    # Defensive: a note with no scene anchor cannot be retired by change/drift,
    # only by the cap. (The endpoint rejects this case; the pure fn stays robust.)
    c = make_correction(
        correction_id=1, text="x", now=T0, anchor_change_at=None, anchor_hash=None, ttl_s=120
    )
    out = _active(c, secs=10, change_at=T0 + timedelta(seconds=5), current_hash=999999)
    assert len(out) == 1
