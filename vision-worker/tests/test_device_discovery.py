from __future__ import annotations

import pytest

from vision_worker.device_discovery import (
    DeviceResolutionError,
    parse_discovery_subnets,
    parse_interface_prefixes,
    parse_ss_peer_ips,
    resolve_url_value,
)


def test_parse_ss_peer_ips_from_face_websocket_connections():
    text = """
ESTAB 0 0 198.51.100.10:8765 198.51.100.42:51432
ESTAB 0 0 198.51.100.10:8765 [::ffff:203.0.113.23]:51433
ESTAB 0 0 127.0.0.1:8765 127.0.0.1:51434
"""

    assert parse_ss_peer_ips(text) == ["198.51.100.42", "203.0.113.23"]


def test_parse_bridge_style_discovery_subnets():
    assert parse_discovery_subnets("192.168.8.0/24,10.1.2 172.20.3.99/24") == [
        "192.168.8",
        "10.1.2",
        "172.20.3",
    ]
    assert parse_discovery_subnets("192.168.8.0/23 bad 999.1.2.0/24") == []


def test_parse_interface_prefixes_uses_local_ipv4_subnets():
    text = """
2: enp0s1    inet 198.51.100.10/24 brd 198.51.100.255 scope global dynamic enp0s1
3: tailscale0    inet 100.64.0.7/32 scope global tailscale0
1: lo    inet 127.0.0.1/8 scope host lo
"""

    assert parse_interface_prefixes(text) == ["198.51.100", "100.64.0"]


def test_resolver_precedence_env_override_wins(tmp_path):
    url, source = resolve_url_value(
        "http://explicit.invalid/snapshot",
        device_id="atom-headroom-m12",
        path="/snapshot",
        env={"MH_DEVICE_REGISTRY_PATH": str(tmp_path / "devices.json")},
        candidate_urls=["http://discovered.invalid/"],
        health_probe=lambda *_: {
            "ok": True,
            "service": "atoms3r-headroom",
            "device_id": "atom-headroom-m12",
        },
    )

    assert source == "env"
    assert url == "http://explicit.invalid/snapshot"


def test_resolver_discovers_when_value_is_auto(tmp_path):
    def probe(base_url, auth_token, timeout_s, device_id):
        assert auth_token == "token"
        assert device_id == "atom-headroom-m12"
        if base_url == "http://candidate.invalid/":
            return {
                "ok": True,
                "service": "atoms3r-headroom",
                "device_id": "atom-headroom-m12",
                "ip": "192.0.2.55",
            }
        return None

    url, source = resolve_url_value(
        "auto",
        device_id="atom-headroom-m12",
        path="/api/headroom/audio",
        env={
            "MH_FACE_AUTH_TOKEN": "token",
            "MH_DEVICE_REGISTRY_PATH": str(tmp_path / "devices.json"),
            "MH_DEVICE_DISCOVERY_CONCURRENCY": "1",
        },
        refresh=True,
        candidate_urls=["http://wrong.invalid/", "http://candidate.invalid/"],
        health_probe=probe,
    )

    assert source == "discovery"
    assert url == "http://candidate.invalid/api/headroom/audio"


def test_resolver_reports_clear_error_when_no_device(tmp_path):
    with pytest.raises(DeviceResolutionError):
        resolve_url_value(
            None,
            device_id="missing",
            path="/snapshot",
            env={
                "MH_DEVICE_REGISTRY_PATH": str(tmp_path / "devices.json"),
                "MH_DEVICE_DISCOVERY_CONCURRENCY": "1",
            },
            refresh=True,
            candidate_urls=["http://candidate.invalid/"],
            health_probe=lambda *_: None,
        )
