# Atom HTTP bridge recovery

When an Atom is powered off or unreachable, speech and lip-sync events can keep
arriving at `scripts/atoms3r-http-bridge.mjs`. Previously, each failed POST could
trigger another sweep of every address in each configured /24 subnet. A subnet
routed through an offline Tailscale peer could therefore keep receiving failed
connection attempts. This is discovery traffic, not evidence that a phone
received those bytes or that a carrier billed them.

The bridge now shares one recovery operation across payload/audio failures,
endpoint heartbeats, WebSocket reconnects, and volume requests. Requests arriving
while a probe or sweep is running join that operation. A request that has already
decided to skip work cannot swallow a later explicit request.

## Automatic recovery policy

An unsuccessful single-address health check is reused for five seconds, so many
lip-sync failures cannot each cause another health request. A failed full sweep
starts a wait of 30 seconds; consecutive failed sweeps increase it to 60, 120,
240, and finally 300 seconds. Every subsequent failed sweep waits 300 seconds.
The wait starts when a sweep finishes, including when it throws. Deadlines use
the monotonic clock (`performance.now()`), so wall-clock corrections cannot
create catch-up scans. The coordinator creates no timers or retry loops.

The existing heartbeat, normally every five seconds, checks the known address
when the short negative cache expires. A healthy response clears both waits and
the failure history. Recovery at that address does not wait for the five-minute
full-sweep deadline. Actual detection time includes the heartbeat cadence and
HTTP request duration; it is not a guaranteed five-second recovery time.

If the Atom comes back at a different address, an eligible heartbeat can run a
full sweep even when no speech is queued. After a long outage this can take up to
the remaining five-minute cooldown, plus heartbeat/request/sweep time. This
bounded delay trades some roaming recovery speed for substantially fewer broad
scans while a device is absent.

A failed explicit volume request bypasses the automatic waits, while still
joining any recovery operation already in progress. A volume request is a user
action rather than a recurring lip-sync event. The existing standalone
`atoms3r-volume.mjs` and `resolve-atoms3r-device.py --refresh` discovery commands
are unchanged; their explicit discovery is not blocked by this bridge's waits.
`ATOM_HEADROOM_DISCOVERY=0` still prevents all bridge subnet sweeps. Existing
authentication/client-error handling and device-identity checks remain in place.

This change bounds health/discovery work. It does not change subnet routes,
device support, POST payload formats, audio routing, or the existing POST queue.
It does not establish a reduction in live or carrier traffic without activation
and measurement.

## Offline validation

From the repository root, run:

    node --test --test-isolation=none test/scripts/atoms3r_discovery_recovery.test.mjs test/scripts/atoms3r_http_bridge_recovery.test.mjs test/scripts/atoms3r_bridge_protocol.test.mjs test/face-app/interpreter_atom_volume.test.mjs
    node --check scripts/atoms3r-http-bridge.mjs
    node --check scripts/atoms3r_discovery_recovery.mjs
    git diff --check

The recovery tests supply fake time and mock all health/network operations. The
script integration fixture also replaces WebSocket, network-interface discovery,
timers, environment, and filesystem reads; it never imports/starts the live
executable or reads real credentials. Tests cover one day offline, repeated
lip-sync failures, concurrent/late manual requests, slow/failed sweeps, recovery
reset, reconnect, a changed address, disabled discovery, and authentication errors.

## Activation is a separate operation

Preparing and testing this branch does not affect a running bridge. After
deployment/restart approval, apply both `scripts/atoms3r-http-bridge.mjs` and
`scripts/atoms3r_discovery_recovery.mjs` together to the live checkout. Verify the
single intended Atom bridge PID and its managed `atoms3r-bridge` session using an
authorized host session. Gracefully stop that verified bridge PID with SIGINT,
confirm it exited, then run the existing `./scripts/ensure-atoms3r-bridge.sh`
from that live checkout with its existing configuration. Do not start a second
bridge or restart the operator, shared web app, twin, or unrelated services.

`ensure-atoms3r-bridge.sh` deliberately leaves an already-running bridge alone;
running it alone, or merely restarting the operator stack, does not guarantee
that this code is loaded. If bridge ownership or host access cannot be verified,
stop activation and report that limitation rather than killing an unidentified
process. No activation commands were run as part of preparing this fix.
