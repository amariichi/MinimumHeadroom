export const DEFAULT_INTERACTIVE_TOGGLE_SELECTOR = "button,input,select,textarea,label,a,[role='button']";

export function shouldIgnoreToggleTarget(target, selector = DEFAULT_INTERACTIVE_TOGGLE_SELECTOR) {
  if (!target || typeof target.closest !== 'function') {
    return false;
  }
  return target.closest(selector) !== null;
}

export function createDoubleTapTracker(options = {}) {
  const maxIntervalMs = Number.isFinite(options.maxIntervalMs) ? Math.max(1, options.maxIntervalMs) : 320;
  const maxDistancePx = Number.isFinite(options.maxDistancePx) ? Math.max(1, options.maxDistancePx) : 20;
  let lastTimestampMs = 0;
  let lastX = 0;
  let lastY = 0;

  return function registerTap(timestampMs, x, y) {
    const intervalMs = timestampMs - lastTimestampMs;
    const distancePx = Math.hypot(x - lastX, y - lastY);

    if (lastTimestampMs > 0 && intervalMs <= maxIntervalMs && distancePx <= maxDistancePx) {
      lastTimestampMs = 0;
      return true;
    }

    lastTimestampMs = timestampMs;
    lastX = x;
    lastY = y;
    return false;
  };
}
