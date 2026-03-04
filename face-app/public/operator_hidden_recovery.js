export function createTapBurstTrigger(options = {}) {
  const requiredCount = Number.isInteger(options.requiredCount) ? Math.max(2, options.requiredCount) : 4;
  const windowMs = Number.isFinite(options.windowMs) ? Math.max(100, Math.floor(options.windowMs)) : 1_500;
  let taps = [];

  return {
    recordTap(nowMs = Date.now()) {
      const now = Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
      taps = taps.filter((timestamp) => now - timestamp <= windowMs);
      taps.push(now);
      if (taps.length >= requiredCount) {
        taps = [];
        return true;
      }
      return false;
    },
    reset() {
      taps = [];
    }
  };
}
