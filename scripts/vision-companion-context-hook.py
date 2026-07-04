#!/usr/bin/env python3
"""Inject a compact shared-vision dialogue brief for voice-mode agents.

This hook is deliberately deterministic. It reads the current user prompt,
fetches the cheap vision-worker `/situation` JSON, keeps a tiny per-session
memory file, and prints a short Japanese `[共有視界ブリーフ]` block. It does not
call `/look` and does not run an LLM.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


TRUTHY = {"1", "true", "yes", "on"}
TOPIC_ALIASES: list[tuple[str, str]] = [
    ("パレスホテル", "パレスホテル"),
    ("お宮", "お宮"),
    ("神社", "神社"),
    ("鳥居", "鳥居"),
    ("カラス", "カラス"),
    ("烏", "カラス"),
    ("トビ", "トビ"),
    ("鳶", "トビ"),
    ("ハト", "ハト"),
    ("鳩", "ハト"),
    ("彫刻", "彫刻"),
    ("像", "像"),
    ("自動販売機", "自動販売機"),
    ("自販機", "自動販売機"),
    ("水", "水"),
    ("噴水", "噴水"),
    ("池", "池"),
    ("PC", "PC"),
    ("パソコン", "PC"),
    ("キーボード", "キーボード"),
    ("ヘッドホン", "ヘッドホン"),
    ("ヘッドフォン", "ヘッドホン"),
    ("マグカップ", "マグカップ"),
    ("コップ", "コップ"),
    ("カメラ", "カメラ"),
    ("タブレット", "タブレット"),
    ("部屋", "部屋"),
    ("机", "机"),
]


def enabled(value: str | None) -> bool:
    return (value or "").strip().lower() in TRUTHY


def safe_key(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return cleaned[:80] or "default"


def session_key() -> str:
    for name in ("MH_FACE_SESSION_ID", "CLAUDE_SESSION_ID", "CODEX_SESSION_ID", "AGENT_ID"):
        value = os.environ.get(name)
        if value and value.strip():
            return safe_key(value)
    return f"pid-{os.getpid()}"


def state_path() -> Path:
    runtime = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp")
    directory = runtime / "minimum-headroom-vision-companion"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{session_key()}.json"


def load_state() -> dict[str, Any]:
    path = state_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: dict[str, Any]) -> None:
    path = state_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def extract_prompt(raw: str) -> str:
    text = raw.strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    found = find_prompt_value(payload)
    return found.strip() if isinstance(found, str) else ""


def find_prompt_value(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("prompt", "user_prompt", "text", "message", "input"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate
        for candidate in value.values():
            found = find_prompt_value(candidate)
            if found:
                return found
    if isinstance(value, list):
        for candidate in value:
            found = find_prompt_value(candidate)
            if found:
                return found
    return None


def fetch_situation() -> dict[str, Any] | None:
    base = (os.environ.get("VISION_BASE_URL") or "http://127.0.0.1:8095").rstrip("/")
    timeout = float(os.environ.get("MH_VISION_COMPANION_TIMEOUT_S") or "1.5")
    request = urllib.request.Request(f"{base}/situation", method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None
    return payload if isinstance(payload, dict) else None


def compact(value: str, limit: int = 80) -> str:
    text = re.sub(r"\s+", " ", value or "").strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1] + "…"


def dedupe_append(items: list[str], new_items: list[str], limit: int = 12) -> list[str]:
    result: list[str] = []
    for item in items + new_items:
        if item and item not in result:
            result.append(item)
    return result[-limit:]


def topics_from(*texts: str) -> list[str]:
    joined = "\n".join(t for t in texts if t)
    topics: list[str] = []
    for needle, label in TOPIC_ALIASES:
        if needle in joined and label not in topics:
            topics.append(label)
    return topics


def detect_user_report(prompt: str) -> str | None:
    patterns = [
        r"目の前に(.{1,24}?)(?:が|は)?(?:います|あります|いる|ある|見えます|見える)",
        r"(.{1,24}?)(?:が|は)(?:います|あります|いる|ある|見えます|見える)",
        r"今(?:度)?は(.{1,24})",
    ]
    for pattern in patterns:
        match = re.search(pattern, prompt)
        if match:
            return compact(match.group(1).strip(" 　。,.、ですけどね"), 40)
    return None


def detect_correction(prompt: str) -> str | None:
    if "じゃなく" in prompt or "違" in prompt:
        return compact(prompt, 60)
    match = re.fullmatch(r"\s*(.{1,16}?)(?:です|ですよ|だよ|でした)[。.\s]*", prompt)
    if match:
        return compact(match.group(1), 40)
    return None


def visual_question(prompt: str) -> bool:
    return bool(re.search(r"(見えますか|見える|何が見え|なにが見え|何か見え|今.*見え)", prompt))


def named_visual_question(prompt: str, prompt_topics: list[str]) -> bool:
    return "見えますか" in prompt and bool(prompt_topics)


def wants_companion(prompt: str, state: dict[str, Any]) -> bool:
    if re.search(r"(おもしろくない|面白くない|見えました.*言うだけ|もうちょっと話|話ができる)", prompt):
        return True
    return bool(state.get("wants_more_natural_conversation"))


def current_overview(digest: dict[str, Any]) -> str:
    current = digest.get("current")
    if isinstance(current, dict):
        return str(current.get("overview") or "")
    return ""


def newest_change(digest: dict[str, Any]) -> str:
    recent = digest.get("recent")
    if isinstance(recent, list):
        for item in recent:
            if isinstance(item, dict) and item.get("change"):
                return str(item["change"])
    return ""


def choose_act(
    *,
    prompt: str,
    prompt_topics: list[str],
    correction: str | None,
    previous_camera: str,
    current_camera: str,
    companion: bool,
) -> str:
    if correction:
        return "repair_misrecognition"
    if named_visual_question(prompt, prompt_topics):
        return "joint_search"
    if visual_question(prompt):
        return "answer_visual_question"
    if previous_camera and current_camera and previous_camera != current_camera:
        return "relate_to_memory"
    if companion:
        return "smalltalk_about_scene"
    return "answer_visual_question"


def build_brief(prompt: str, digest: dict[str, Any], state: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    previous_camera = str(state.get("previous_camera") or "")
    camera = current_overview(digest)
    change = newest_change(digest)
    prompt_topics = topics_from(prompt)
    camera_topics = topics_from(camera, change)
    topics = dedupe_append(list(state.get("recent_topics") or []), prompt_topics + camera_topics)
    report = detect_user_report(prompt)
    correction = detect_correction(prompt)
    companion = wants_companion(prompt, state)
    user_reports = list(state.get("user_reports") or [])
    if report:
        user_reports = dedupe_append(user_reports, [report], limit=6)
    corrections = list(state.get("corrections") or [])
    if correction:
        corrections = dedupe_append(corrections, [correction], limit=6)

    act = choose_act(
        prompt=prompt,
        prompt_topics=prompt_topics,
        correction=correction,
        previous_camera=previous_camera,
        current_camera=camera,
        companion=companion,
    )

    lines = ["[共有視界ブリーフ]"]
    if companion:
        lines.append("会話モード: companion（見えたものの列挙より自然な会話を優先）")
    if camera:
        lines.append(f"カメラ現在: {compact(camera)}")
    if previous_camera and camera and previous_camera != camera:
        lines.append(f"直前との差: {compact(previous_camera, 40)} → {compact(camera, 40)}")
    elif change:
        lines.append(f"直近の変化: {compact(change)}")
    if user_reports:
        lines.append("ユーザー報告: " + "、".join(user_reports[-3:]))
    if corrections:
        lines.append("直近の訂正: " + "、".join(corrections[-3:]))
    if topics:
        lines.append("最近の話題: " + "、".join(topics[-8:]))
    lines.append(f"推奨応答: {act}。1〜2文。物体列挙ではなく、前の場面やユーザー発話とつなげる。")

    next_state = {
        "previous_camera": camera or previous_camera,
        "recent_topics": topics,
        "user_reports": user_reports[-6:],
        "corrections": corrections[-6:],
        "wants_more_natural_conversation": companion,
        "updated_at": int(time.time()),
    }
    output = "\n".join(lines)
    return output[:1200], next_state


def main() -> int:
    if not enabled(os.environ.get("MH_VISION_COMPANION")):
        return 0
    raw = sys.stdin.read()
    prompt = extract_prompt(raw)
    digest = fetch_situation()
    if digest is None:
        return 0
    state = load_state()
    brief, next_state = build_brief(prompt, digest, state)
    save_state(next_state)
    if brief.strip():
        print(brief)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
