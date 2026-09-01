#pragma once

#include <Arduino.h>

#include "headroom_settings.h"

// Outcome of one attempt to choose which face-app address this device talks to.
struct FaceEndpointSelection {
  // True when an mDNS answer was verified reachable and folded into the URLs.
  bool resolved = false;
  // Host present in faceWsUrl after the call: the adopted mDNS answer, or the
  // provisioned (static) host when nothing was adopted.
  String host;
};

// Replaces the host in url with newHost, keeping scheme, port and path.
// Returns url unchanged when it has no "scheme://" prefix.
String replaceUrlHost(const String& url, const String& newHost);

// Host part of url: "192.168.1.38" for "ws://192.168.1.38:8765/ws".
String urlHost(const String& url);

// Resolves data.mdnsHost and rewrites data.faceWsUrl / data.faceHttpBase to an
// address this device can actually open a TCP connection to. Answers on the
// device's own subnet are tried first, and every answer is probed before it is
// adopted. When the name resolves to nothing, or to nothing reachable, the
// provisioned URLs are left untouched — off-LAN that is the stable Tailscale
// address that carries the connection. Mutates the caller's copy only; the
// provisioned settings in NVS are never overwritten.
FaceEndpointSelection resolveFaceEndpoint(HeadroomSettingsData& data);
