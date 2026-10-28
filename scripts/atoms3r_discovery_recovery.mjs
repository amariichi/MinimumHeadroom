// One recovery operation shared by heartbeat, payload/audio failures and volume.
// No timers or network calls live here; the bridge supplies both probes and time.
export function createAtomDiscoveryRecovery({
  probe,
  discover,
  now = () => performance.now(),
  probeIntervalMs = 5_000,
  initialCooldownMs = 30_000,
  maxCooldownMs = 300_000
}) {
  if (![probeIntervalMs, initialCooldownMs, maxCooldownMs].every(Number.isFinite)
    || probeIntervalMs <= 0 || initialCooldownMs <= 0 || maxCooldownMs < initialCooldownMs) {
    throw new RangeError('Invalid Atom discovery recovery intervals');
  }
  let active = null;
  let nextProbeAt = -Infinity;
  let nextDiscoveryAt = -Infinity;
  let cooldownMs = initialCooldownMs;

  function healthy(health) {
    nextProbeAt = -Infinity;
    nextDiscoveryAt = -Infinity;
    cooldownMs = initialCooldownMs;
    return health;
  }

  function ensureReachable(reason, { force = false, allowDiscovery = true } = {}) {
    if (active && !active.settled) {
      // A manual request can upgrade a heartbeat already checking the endpoint;
      // it still joins that operation rather than starting a second sweep.
      active.force ||= force;
      active.allowDiscovery ||= allowDiscovery;
      return active.promise;
    }
    const operation = { reason, force, allowDiscovery, settled: false, promise: null };
    active = operation;
    operation.promise = Promise.resolve().then(async () => {
      try {
        if (!operation.force && now() < nextProbeAt) return null;
        const health = await probe();
        if (health) return healthy(health);
        nextProbeAt = now() + probeIntervalMs;
        if (!operation.allowDiscovery || (!operation.force && now() < nextDiscoveryAt)) return null;
        let recovered = null;
        try {
          recovered = await discover(operation.reason);
          return recovered ? healthy(recovered) : null;
        } finally {
          if (!recovered) {
            // Start the wait at completion, including thrown/failed sweeps. A long
            // sweep cannot consume its own cooldown and immediately run again.
            nextDiscoveryAt = now() + cooldownMs;
            cooldownMs = Math.min(maxCooldownMs, cooldownMs * 2);
          }
        }
      } finally {
        // A cached no-op can finish before its Promise's cleanup microtask.
        // Do not let a manual request join that already-decided null result.
        operation.settled = true;
      }
    }).finally(() => { if (active === operation) active = null; });
    return operation.promise;
  }

  return { ensureReachable };
}
