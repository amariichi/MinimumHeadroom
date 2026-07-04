"""AtomS3R device discovery shared by the M12 vision stack.

The faced Atom bridge already self-heals by probing candidate AtomS3R
``/health`` endpoints on local and configured /24 subnets. This module keeps the
vision stack aligned with that mechanism and adds phone-home candidates learned
from established device -> PC websocket connections on port 8765.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import ipaddress
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import urlparse, urlunparse

DEFAULT_REGISTRY_PATH = "~/.cache/minimum-headroom/atoms3r-devices.json"
DEFAULT_M12_DEVICE_ID = "atom-headroom-m12"
DEFAULT_FACE_DEVICE_ID = "atom-headroom-1"
DEFAULT_DISCOVERY_TIMEOUT_MS = 450
DEFAULT_DISCOVERY_CONCURRENCY = 32
DEFAULT_CACHE_TTL_S = 300

HealthProbe = Callable[[str, str, float, str], dict | None]


class DeviceResolutionError(RuntimeError):
    """Raised when a device id cannot be resolved to a current base URL."""


@dataclass(frozen=True)
class DeviceRecord:
    device_id: str
    base_url: str
    ip: str
    last_seen: float

    def as_json(self) -> dict:
        return {
            "device_id": self.device_id,
            "base_url": self.base_url,
            "ip": self.ip,
            "last_seen": self.last_seen,
        }


def is_auto(value: str | None) -> bool:
    return value is None or value.strip() == "" or value.strip().lower() == "auto"


def normalize_base_url(value: str) -> str:
    parsed = urlparse(value)
    if not parsed.scheme:
        parsed = urlparse(f"http://{value}")
    path = parsed.path
    if path in {"", "/"}:
        path = "/"
    else:
        path = path.rstrip("/") + "/"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))


def device_url(base_url: str, path: str) -> str:
    parsed = urlparse(normalize_base_url(base_url))
    clean_path = "/" + path.lstrip("/")
    return urlunparse((parsed.scheme, parsed.netloc, clean_path, "", "", ""))


def parse_discovery_subnets(value: str | None) -> list[str]:
    """Return bridge-compatible a.b.c prefixes from /24 entries."""
    out: list[str] = []
    if not value:
        return out
    for raw in str(value).split():
        for entry in raw.split(","):
            entry = entry.strip()
            if not entry:
                continue
            parts = entry.split("/")
            if len(parts) > 2:
                continue
            if len(parts) == 2 and parts[1] != "24":
                continue
            octets = parts[0].split(".")
            if len(octets) == 3:
                prefix_octets = octets
            elif len(octets) == 4:
                prefix_octets = octets[:3]
            else:
                continue
            try:
                nums = [int(part) for part in prefix_octets]
            except ValueError:
                continue
            if all(0 <= num <= 255 for num in nums):
                out.append(".".join(str(num) for num in nums))
    return list(dict.fromkeys(out))


def parse_interface_prefixes(ip_addr_output: str) -> list[str]:
    """Parse ``ip -o -4 addr`` output into bridge-style /24 prefixes."""
    prefixes: list[str] = []
    for line in ip_addr_output.splitlines():
        parts = line.split()
        if "inet" not in parts:
            continue
        idx = parts.index("inet")
        if idx + 1 >= len(parts):
            continue
        try:
            iface = ipaddress.ip_interface(parts[idx + 1])
        except ValueError:
            continue
        if iface.version != 4 or iface.ip.is_loopback:
            continue
        octets = str(iface.ip).split(".")
        prefixes.append(".".join(octets[:3]))
    return list(dict.fromkeys(prefixes))


def parse_ss_peer_ips(ss_output: str) -> list[str]:
    """Extract remote IPv4 peers from ``ss -tnH sport = :8765`` output."""
    ips: list[str] = []
    for line in ss_output.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        # ss -tnH: State Recv-Q Send-Q LocalAddress:Port PeerAddress:Port
        host = _host_from_sockaddr(parts[4])
        if not host:
            continue
        if host.startswith("::ffff:"):
            host = host.removeprefix("::ffff:")
        try:
            ip = ipaddress.ip_address(host)
        except ValueError:
            continue
        if ip.version == 4 and not ip.is_loopback:
            ips.append(str(ip))
    return list(dict.fromkeys(ips))


def _host_from_sockaddr(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 1 else None
    if ":" not in value:
        return value
    return value.rsplit(":", 1)[0]


def load_registry(path: str | os.PathLike[str] | None = None) -> dict[str, DeviceRecord]:
    registry_path = Path(os.path.expanduser(str(path or DEFAULT_REGISTRY_PATH)))
    try:
        raw = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    devices = raw.get("devices", raw) if isinstance(raw, dict) else {}
    out: dict[str, DeviceRecord] = {}
    if not isinstance(devices, dict):
        return out
    for device_id, item in devices.items():
        if not isinstance(item, dict):
            continue
        base_url = item.get("base_url")
        ip = item.get("ip")
        last_seen = item.get("last_seen")
        if isinstance(device_id, str) and isinstance(base_url, str) and isinstance(ip, str):
            try:
                last_seen_f = float(last_seen)
            except (TypeError, ValueError):
                last_seen_f = 0.0
            out[device_id] = DeviceRecord(device_id, normalize_base_url(base_url), ip, last_seen_f)
    return out


def save_registry(
    records: dict[str, DeviceRecord],
    path: str | os.PathLike[str] | None = None,
) -> None:
    registry_path = Path(os.path.expanduser(str(path or DEFAULT_REGISTRY_PATH)))
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    body = {
        "updated_at": time.time(),
        "devices": {device_id: record.as_json() for device_id, record in sorted(records.items())},
    }
    tmp = registry_path.with_suffix(registry_path.suffix + ".tmp")
    tmp.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(registry_path)


def resolve_url_value(
    explicit_value: str | None,
    *,
    device_id: str,
    path: str,
    env: dict[str, str] | os._Environ[str] | None = None,
    refresh: bool = False,
    candidate_urls: Iterable[str] | None = None,
    health_probe: HealthProbe | None = None,
) -> tuple[str, str]:
    """Return ``(url, source)`` respecting explicit-env > discovery."""
    if not is_auto(explicit_value):
        return explicit_value.strip(), "env"
    record = resolve_device(
        device_id,
        env=env,
        refresh=refresh,
        candidate_urls=candidate_urls,
        health_probe=health_probe,
    )
    return device_url(record.base_url, path), "discovery"


def resolve_device_url(
    device_id: str,
    path: str,
    *,
    env: dict[str, str] | os._Environ[str] | None = None,
    refresh: bool = False,
) -> str:
    record = resolve_device(device_id, env=env, refresh=refresh)
    return device_url(record.base_url, path)


def resolve_device(
    device_id: str,
    *,
    env: dict[str, str] | os._Environ[str] | None = None,
    refresh: bool = False,
    candidate_urls: Iterable[str] | None = None,
    health_probe: HealthProbe | None = None,
) -> DeviceRecord:
    env = os.environ if env is None else env
    now = time.time()
    registry_path = env.get("MH_DEVICE_REGISTRY_PATH") or DEFAULT_REGISTRY_PATH
    cache_ttl_s = _positive_float(env.get("MH_DEVICE_REGISTRY_TTL_S"), DEFAULT_CACHE_TTL_S)
    records = load_registry(registry_path)

    cached = records.get(device_id)
    if cached and not refresh and now - cached.last_seen <= cache_ttl_s:
        return cached

    auth_token = env.get("MH_FACE_AUTH_TOKEN", "")
    timeout_s = _positive_float(env.get("MH_DEVICE_DISCOVERY_TIMEOUT_MS"), DEFAULT_DISCOVERY_TIMEOUT_MS) / 1000.0
    concurrency = _positive_int(env.get("MH_DEVICE_DISCOVERY_CONCURRENCY"), DEFAULT_DISCOVERY_CONCURRENCY)
    probe = health_probe or probe_health
    candidates = list(
        candidate_urls
        if candidate_urls is not None
        else discover_candidate_urls(env=env, registry=records)
    )

    found = _probe_candidates(
        candidates,
        device_id=device_id,
        auth_token=auth_token,
        timeout_s=timeout_s,
        concurrency=concurrency,
        health_probe=probe,
    )
    if found is None:
        if cached:
            return cached
        raise DeviceResolutionError(f"no AtomS3R device found for device_id={device_id!r}")

    records[device_id] = found
    save_registry(records, registry_path)
    return found


def discover_candidate_urls(
    *,
    env: dict[str, str] | os._Environ[str] | None = None,
    registry: dict[str, DeviceRecord] | None = None,
) -> list[str]:
    env = os.environ if env is None else env
    urls: list[str] = []

    def add(value: str | None) -> None:
        if value and not is_auto(value):
            urls.append(normalize_base_url(value))

    if registry:
        for record in registry.values():
            add(record.base_url)

    add(env.get("ATOM_HEADROOM_URL"))
    add(env.get("VISION_CAMERA_URL"))
    add(env.get("M12_AUDIO_URL"))

    for ip in parse_ss_peer_ips(_run_text(["ss", "-tnH", "sport", "=", ":8765"])):
        add(f"http://{ip}/")

    prefixes = parse_interface_prefixes(_run_text(["ip", "-o", "-4", "addr", "show", "scope", "global"]))
    prefixes.extend(parse_discovery_subnets(env.get("ATOM_HEADROOM_DISCOVERY_SUBNETS")))
    prefixes.extend(parse_discovery_subnets(env.get("MH_ATOM_DISCOVERY_SUBNETS")))
    for prefix in dict.fromkeys(prefixes):
        for host in range(1, 255):
            add(f"http://{prefix}.{host}/")

    return list(dict.fromkeys(urls))


def probe_health(base_url: str, auth_token: str, timeout_s: float, device_id: str) -> dict | None:
    req = urllib.request.Request(device_url(base_url, "/health"))
    if auth_token:
        req.add_header("X-Headroom-Auth", auth_token)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            if resp.status < 200 or resp.status >= 300:
                return None
            payload = json.loads(resp.read().decode("utf-8"))
    except (OSError, TimeoutError, ValueError, urllib.error.URLError):
        return None
    if not _health_matches(payload, device_id):
        return None
    return payload


def _probe_candidates(
    candidates: list[str],
    *,
    device_id: str,
    auth_token: str,
    timeout_s: float,
    concurrency: int,
    health_probe: HealthProbe,
) -> DeviceRecord | None:
    if not candidates:
        return None
    found: DeviceRecord | None = None

    def probe_one(url: str) -> DeviceRecord | None:
        payload = health_probe(url, auth_token, timeout_s, device_id)
        if not payload:
            return None
        parsed = urlparse(normalize_base_url(url))
        return DeviceRecord(
            device_id=device_id,
            base_url=normalize_base_url(url),
            ip=str(payload.get("ip") or parsed.hostname or ""),
            last_seen=time.time(),
        )

    executor = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, concurrency))
    try:
        future_map = {executor.submit(probe_one, url): url for url in candidates}
        for future in concurrent.futures.as_completed(future_map):
            try:
                record = future.result()
            except Exception:  # noqa: BLE001 - one bad probe must not break discovery
                continue
            if record is not None:
                found = record
                executor.shutdown(wait=False, cancel_futures=True)
                return found
    finally:
        executor.shutdown(wait=False, cancel_futures=True)
    return found


def _health_matches(payload: object, device_id: str) -> bool:
    if not isinstance(payload, dict):
        return False
    if payload.get("ok") is not True or payload.get("service") != "atoms3r-headroom":
        return False
    return payload.get("device_id") == device_id


def _run_text(cmd: list[str]) -> str:
    try:
        out = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout if out.returncode == 0 else ""


def _positive_int(value: str | None, fallback: int) -> int:
    try:
        parsed = int(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def _positive_float(value: str | None, fallback: float) -> float:
    try:
        parsed = float(value or "")
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Resolve an AtomS3R device URL by device_id.")
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--path", default="/")
    parser.add_argument("--refresh", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        record = resolve_device(args.device_id, refresh=args.refresh)
    except DeviceResolutionError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    url = device_url(record.base_url, args.path)
    if args.json:
        print(json.dumps({**record.as_json(), "url": url}, ensure_ascii=False))
    else:
        print(url)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
