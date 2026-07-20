export const DEFAULT_INTERACTIVE_TOGGLE_SELECTOR = "button,input,select,textarea,label,a,[role='button'],[data-stage-gesture-ignore]";
export const DEFAULT_PAGE_ZOOM_ALLOWED_SELECTOR = ".operator-mirror";

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

export function targetMatchesSelector(target, selector) {
  if (!target || typeof target.closest !== 'function' || typeof selector !== 'string' || selector.trim() === '') {
    return false;
  }
  return target.closest(selector) !== null;
}

export function shouldPreventPageZoomGesture(event, options = {}) {
  if (!event) {
    return false;
  }

  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'gesturestart' || type === 'gesturechange' || type === 'gestureend') {
    return true;
  }

  const allowedSelector = options.allowedSelector ?? DEFAULT_PAGE_ZOOM_ALLOWED_SELECTOR;
  if (targetMatchesSelector(event.target, allowedSelector)) {
    return false;
  }

  const touches = event.touches;
  return Boolean(touches && touches.length >= 2);
}
