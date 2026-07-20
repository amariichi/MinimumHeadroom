const DEFAULT_EDGE_PADDING_PX = 8;

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeRect(rect = {}) {
  const left = finiteNumber(rect.left);
  const top = finiteNumber(rect.top);
  const width = Math.max(0, finiteNumber(rect.width, finiteNumber(rect.right) - left));
  const height = Math.max(0, finiteNumber(rect.height, finiteNumber(rect.bottom) - top));
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function constrainPanelRect(rect, boundsRect, edgePadding = DEFAULT_EDGE_PADDING_PX) {
  const panel = normalizeRect(rect);
  const bounds = normalizeRect(boundsRect);
  const padding = Math.max(0, finiteNumber(edgePadding, DEFAULT_EDGE_PADDING_PX));
  const minLeft = bounds.left + padding;
  const minTop = bounds.top + padding;
  const maxLeft = Math.max(minLeft, bounds.right - padding - panel.width);
  const maxTop = Math.max(minTop, bounds.bottom - padding - panel.height);
  const left = clamp(panel.left, minLeft, maxLeft);
  const top = clamp(panel.top, minTop, maxTop);

  return {
    left,
    top,
    deltaX: left - panel.left,
    deltaY: top - panel.top
  };
}

function isMeasurableRect(rect) {
  const normalized = normalizeRect(rect);
  return normalized.width > 0 && normalized.height > 0;
}

function isPrimaryDragPointer(event) {
  if (!event || event.isPrimary === false) {
    return false;
  }
  return event.pointerType !== 'mouse' || event.button === 0;
}

export function createDraggablePanel(options = {}) {
  const element = options.element;
  const handle = options.handle ?? element;
  const bounds = options.bounds ?? element?.offsetParent;
  const windowTarget = options.windowTarget ?? globalThis.window;
  const edgePadding = Number.isFinite(options.edgePadding)
    ? Math.max(0, Number(options.edgePadding))
    : DEFAULT_EDGE_PADDING_PX;

  if (!element?.getBoundingClientRect || !handle?.addEventListener || !bounds?.getBoundingClientRect) {
    throw new TypeError('A draggable panel requires element, handle, and bounds elements.');
  }

  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startTranslateX = 0;
  let startTranslateY = 0;
  let startRect = null;
  let translateX = 0;
  let translateY = 0;

  function applyTranslation() {
    element.style?.setProperty?.('--draggable-panel-x', `${translateX}px`);
    element.style?.setProperty?.('--draggable-panel-y', `${translateY}px`);
  }

  function clampToBounds() {
    const panelRect = element.getBoundingClientRect();
    const boundsRect = bounds.getBoundingClientRect();
    if (!isMeasurableRect(panelRect) || !isMeasurableRect(boundsRect)) {
      return { x: translateX, y: translateY };
    }
    const constrained = constrainPanelRect(panelRect, boundsRect, edgePadding);
    if (constrained.deltaX !== 0 || constrained.deltaY !== 0) {
      translateX += constrained.deltaX;
      translateY += constrained.deltaY;
      applyTranslation();
    }
    return { x: translateX, y: translateY };
  }

  function beginDrag(event) {
    if (pointerId !== null || !isPrimaryDragPointer(event)) {
      return;
    }

    clampToBounds();
    const panelRect = element.getBoundingClientRect();
    const boundsRect = bounds.getBoundingClientRect();
    if (!isMeasurableRect(panelRect) || !isMeasurableRect(boundsRect)) {
      return;
    }

    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startTranslateX = translateX;
    startTranslateY = translateY;
    startRect = normalizeRect(panelRect);
    element.classList?.add?.('is-dragging');
    if (element.style) {
      element.style.willChange = 'transform';
    }
    try {
      handle.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture can be rejected when the pointer has already ended.
    }
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  function updateDrag(event) {
    if (pointerId === null || event?.pointerId !== pointerId || !startRect) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const proposedRect = {
      ...startRect,
      left: startRect.left + deltaX,
      top: startRect.top + deltaY,
      right: startRect.right + deltaX,
      bottom: startRect.bottom + deltaY
    };
    const constrained = constrainPanelRect(proposedRect, bounds.getBoundingClientRect(), edgePadding);
    translateX = startTranslateX + constrained.left - startRect.left;
    translateY = startTranslateY + constrained.top - startRect.top;
    applyTranslation();
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  function finishDrag(event, releaseCapture = true) {
    if (pointerId === null || event?.pointerId !== pointerId) {
      return;
    }

    const finishedPointerId = pointerId;
    pointerId = null;
    startRect = null;
    element.classList?.remove?.('is-dragging');
    if (element.style) {
      element.style.willChange = '';
    }
    if (releaseCapture) {
      try {
        handle.releasePointerCapture?.(finishedPointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  const handlePointerUp = (event) => finishDrag(event, true);
  const handlePointerCancel = (event) => finishDrag(event, true);
  const handleLostPointerCapture = (event) => finishDrag(event, false);
  handle.addEventListener('pointerdown', beginDrag, { passive: false });
  handle.addEventListener('pointermove', updateDrag, { passive: false });
  handle.addEventListener('pointerup', handlePointerUp, { passive: false });
  handle.addEventListener('pointercancel', handlePointerCancel, { passive: false });
  handle.addEventListener('lostpointercapture', handleLostPointerCapture);
  windowTarget?.addEventListener?.('resize', clampToBounds);
  windowTarget?.visualViewport?.addEventListener?.('resize', clampToBounds);

  return Object.freeze({
    clampToBounds,
    snapshot() {
      return Object.freeze({ x: translateX, y: translateY, dragging: pointerId !== null });
    },
    destroy() {
      handle.removeEventListener?.('pointerdown', beginDrag);
      handle.removeEventListener?.('pointermove', updateDrag);
      handle.removeEventListener?.('pointerup', handlePointerUp);
      handle.removeEventListener?.('pointercancel', handlePointerCancel);
      handle.removeEventListener?.('lostpointercapture', handleLostPointerCapture);
      windowTarget?.removeEventListener?.('resize', clampToBounds);
      windowTarget?.visualViewport?.removeEventListener?.('resize', clampToBounds);
      element.classList?.remove?.('is-dragging');
      if (element.style) {
        element.style.willChange = '';
      }
      pointerId = null;
      startRect = null;
    }
  });
}
