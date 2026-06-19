"""Alert watches.

A "watch" is a named rule the user registers ("tell me if you see a red
light"). On every committed observation the registry checks the active watches
against the observation's text. Keyword watches are evaluated here (text only).
Enum watches — a constrained model question per frame, e.g. is the red signal
illuminated — require a model call and are handled in the GPU-backed path
(milestone M5 with the model), so they are accepted and listed but not fired by
this text-only evaluator.

Reminder: this is informational/assistive only and must never be relied on as a
safety device (see DISCLAIMER in app.py).
"""

from __future__ import annotations

from dataclasses import dataclass

from .records import Observation


@dataclass
class Watch:
    name: str
    rule: str
    kind: str = "keyword"  # "keyword" | "enum"


def _haystack(obs: Observation) -> str:
    return " ".join([obs.overview or "", obs.ocr_full or "", obs.change_from_prev or ""]).lower()


def keyword_matches(rule: str, obs: Observation) -> bool:
    return rule.strip().lower() in _haystack(obs)


class WatchRegistry:
    def __init__(self) -> None:
        self._watches: list[Watch] = []

    def add(self, watch: Watch) -> None:
        self._watches.append(watch)

    def list(self) -> list[dict]:
        return [{"name": w.name, "rule": w.rule, "kind": w.kind} for w in self._watches]

    def __len__(self) -> int:
        return len(self._watches)

    def evaluate(self, obs: Observation) -> list[Watch]:
        """Return the watches that fire for this observation (keyword only)."""
        fired: list[Watch] = []
        for watch in self._watches:
            if watch.kind == "keyword" and keyword_matches(watch.rule, obs):
                fired.append(watch)
            # kind == "enum" needs a constrained model call per frame; deferred to
            # the GPU-backed alert path and not fired by this text-only evaluator.
        return fired
