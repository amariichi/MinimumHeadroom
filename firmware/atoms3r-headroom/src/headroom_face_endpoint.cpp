#include "headroom_face_endpoint.h"

#include <ESPmDNS.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <mdns.h>

namespace {

// One PC usually publishes several addresses under a single .local name: the
// LAN address we want, plus VPN (Tailscale, 100.64.0.0/10) and container
// bridge (172.16.0.0/12) addresses that this device can never reach. Asking
// for a single A record returns whichever answer wins the race, which is how a
// device ends up wedged on an unreachable host. Collect every answer instead,
// then choose by reachability.
constexpr size_t kMaxCandidates = 8;
constexpr uint32_t kQueryTimeoutMs = 2000;
constexpr int32_t kProbeTimeoutMs = 800;
constexpr uint16_t kDefaultWsPort = 8765;

bool mdnsStarted = false;

bool ensureMdnsStarted(const String& deviceId) {
  if (mdnsStarted) {
    return true;
  }
  mdnsStarted = MDNS.begin(deviceId.c_str());
  if (!mdnsStarted) {
    Serial.println("mdns: MDNS.begin failed; keeping static ws_url/http_base");
  }
  return mdnsStarted;
}

String urlAuthority(const String& url) {
  int schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) {
    return String();
  }
  int authStart = schemeEnd + 3;
  int pathStart = url.indexOf('/', authStart);
  return pathStart >= 0 ? url.substring(authStart, pathStart) : url.substring(authStart);
}

uint16_t urlPort(const String& url, uint16_t fallback) {
  String authority = urlAuthority(url);
  int portStart = authority.indexOf(':');
  if (portStart < 0) {
    return fallback;
  }
  long port = authority.substring(portStart + 1).toInt();
  if (port <= 0 || port > 65535) {
    return fallback;
  }
  return static_cast<uint16_t>(port);
}

bool sameAddress(const IPAddress& a, const IPAddress& b) {
  return static_cast<uint32_t>(a) == static_cast<uint32_t>(b);
}

// Every IPv4 A record published for host, de-duplicated, in the order the
// responder returned them. Returns the number written to out.
size_t queryHostAddresses(const String& host, IPAddress* out, size_t maxOut) {
  mdns_result_t* results = nullptr;
  esp_err_t err =
      mdns_query(host.c_str(), nullptr, nullptr, MDNS_TYPE_A, kQueryTimeoutMs, maxOut, &results);
  if (err != ESP_OK || results == nullptr) {
    if (results != nullptr) {
      mdns_query_results_free(results);
    }
    return 0;
  }

  size_t count = 0;
  for (mdns_result_t* result = results; result != nullptr && count < maxOut; result = result->next) {
    for (mdns_ip_addr_t* addr = result->addr; addr != nullptr && count < maxOut; addr = addr->next) {
      if (addr->addr.type != ESP_IPADDR_TYPE_V4) {
        continue;
      }
      IPAddress ip(addr->addr.u_addr.ip4.addr);
      bool duplicate = false;
      for (size_t i = 0; i < count; ++i) {
        if (sameAddress(out[i], ip)) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) {
        out[count++] = ip;
      }
    }
  }
  mdns_query_results_free(results);
  return count;
}

bool onDeviceSubnet(const IPAddress& ip) {
  uint32_t local = static_cast<uint32_t>(WiFi.localIP());
  uint32_t mask = static_cast<uint32_t>(WiFi.subnetMask());
  if (mask == 0) {
    return false;
  }
  return (static_cast<uint32_t>(ip) & mask) == (local & mask);
}

// A TCP handshake is the only honest test of "can this device reach that
// address": a name can resolve, and the address can even be pingable from
// somewhere else, while the return path to this device is broken.
bool probeTcp(const IPAddress& ip, uint16_t port) {
  WiFiClient client;
  bool ok = client.connect(ip, port, kProbeTimeoutMs) == 1;
  client.stop();
  return ok;
}

}  // namespace

String replaceUrlHost(const String& url, const String& newHost) {
  int schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) {
    return url;
  }
  int authStart = schemeEnd + 3;
  int pathStart = url.indexOf('/', authStart);
  String authority = pathStart >= 0 ? url.substring(authStart, pathStart) : url.substring(authStart);
  String rest = pathStart >= 0 ? url.substring(pathStart) : String();
  int portStart = authority.indexOf(':');
  String portPart = portStart >= 0 ? authority.substring(portStart) : String();  // keeps leading ':'
  return url.substring(0, authStart) + newHost + portPart + rest;
}

String urlHost(const String& url) {
  String authority = urlAuthority(url);
  int portStart = authority.indexOf(':');
  return portStart >= 0 ? authority.substring(0, portStart) : authority;
}

FaceEndpointSelection resolveFaceEndpoint(HeadroomSettingsData& data) {
  FaceEndpointSelection selection;
  selection.host = urlHost(data.faceWsUrl);

  if (data.mdnsHost.length() == 0) {
    return selection;
  }
  String host = data.mdnsHost;
  host.trim();
  if (host.endsWith(".local")) {
    host = host.substring(0, host.length() - 6);  // the query appends .local itself
  }
  if (host.length() == 0) {
    return selection;
  }
  if (!ensureMdnsStarted(data.deviceId)) {
    return selection;
  }

  IPAddress candidates[kMaxCandidates];
  size_t count = queryHostAddresses(host, candidates, kMaxCandidates);
  if (count == 0) {
    Serial.printf("mdns: resolve failed for %s.local; keeping static ws_url/http_base\n",
                  host.c_str());
    return selection;
  }

  uint16_t port = urlPort(data.faceWsUrl, kDefaultWsPort);
  // Pass 0 takes answers on this device's own subnet, pass 1 everything else,
  // so a routable LAN address always beats a VPN or bridge address that merely
  // answered first.
  for (int pass = 0; pass < 2; ++pass) {
    for (size_t i = 0; i < count; ++i) {
      bool local = onDeviceSubnet(candidates[i]);
      if ((pass == 0) != local) {
        continue;
      }
      String ipStr = candidates[i].toString();
      if (!probeTcp(candidates[i], port)) {
        Serial.printf("mdns: %s.local -> %s port %u unreachable; trying next answer\n",
                      host.c_str(), ipStr.c_str(), static_cast<unsigned>(port));
        continue;
      }
      Serial.printf("mdns: %s.local -> %s (%s subnet, port %u reachable)\n", host.c_str(),
                    ipStr.c_str(), local ? "same" : "other", static_cast<unsigned>(port));
      if (data.faceWsUrl.length() > 0) {
        data.faceWsUrl = replaceUrlHost(data.faceWsUrl, ipStr);
      }
      if (data.faceHttpBase.length() > 0) {
        data.faceHttpBase = replaceUrlHost(data.faceHttpBase, ipStr);
      }
      selection.resolved = true;
      selection.host = ipStr;
      return selection;
    }
  }

  Serial.printf("mdns: %u answer(s) for %s.local, none reachable; keeping static ws_url/http_base\n",
                static_cast<unsigned>(count), host.c_str());
  return selection;
}
