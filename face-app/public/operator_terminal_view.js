const DEFAULT_SESSION_ID = 'default';
const DEFAULT_FONT_SIZE = 14;
const DEFAULT_SCROLLBACK = 5000;
const COPY_HOLD_MS = 550;
const COPY_MOVE_THRESHOLD_PX = 10;
const COPY_STATUS_TTL_MS = 1600;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function decodeBase64Bytes(value) {
  const binary = atob(typeof value === 'string' ? value : '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function supportsGzipDecompression() {
  if (
    typeof globalThis.DecompressionStream !== 'function'
    || typeof globalThis.Blob !== 'function'
    || typeof globalThis.Response !== 'function'
  ) {
    return false;
  }
  try {
    new DecompressionStream('gzip');
    return true;
  } catch {
    return false;
  }
}

export async function decodeTerminalPayloadBytes(message) {
  const bytes = decodeBase64Bytes(message?.data_base64);
  const encoding = asNonEmptyString(message?.data_encoding) ?? 'base64';
  if (encoding === 'base64') {
    return bytes;
  }
  if (encoding !== 'gzip-base64' || !supportsGzipDecompression()) {
    throw new Error(`Unsupported terminal data encoding: ${encoding}`);
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const decoded = new Uint8Array(await new Response(stream).arrayBuffer());
  if (
    Number.isSafeInteger(message?.data_uncompressed_bytes)
    && message.data_uncompressed_bytes >= 0
    && decoded.length !== message.data_uncompressed_bytes
  ) {
    throw new Error('Terminal data length mismatch after gzip decompression');
  }
  return decoded;
}

function createClipboardWriter(options = {}) {
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard ?? null;
  const documentRef = options.documentRef ?? globalThis.document ?? null;

  function writeWithSelection(text) {
    if (!documentRef || typeof documentRef.createElement !== 'function') {
      return false;
    }
    const textarea = documentRef.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.inset = '0 auto auto -10000px';
    documentRef.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = documentRef.execCommand?.('copy') === true;
    } finally {
      textarea.remove();
    }
    if (!copied) {
      return false;
    }
    return true;
  }

  return async function writeClipboard(text, { preferSynchronous = false } = {}) {
    let selectionAttempted = false;
    if (preferSynchronous) {
      selectionAttempted = true;
      if (writeWithSelection(text)) {
        return true;
      }
    }
    let clipboardError = null;
    if (clipboard && typeof clipboard.writeText === 'function') {
      try {
        await clipboard.writeText(text);
        return true;
      } catch (error) {
        clipboardError = error;
      }
    }
    if (!selectionAttempted && writeWithSelection(text)) {
      return true;
    }
    throw clipboardError ?? new Error('Clipboard write was rejected');
  };
}

export function createTerminalCopyGesture(options = {}) {
  const surface = options.surface;
  const host = options.host ?? surface;
  const terminal = options.terminal;
  const status = options.status ?? null;
  const statusText = options.statusText ?? status;
  const retryButton = options.retryButton ?? null;
  const accessibleCopyButton = options.accessibleCopyButton ?? null;
  const holdMs = Number.isFinite(options.holdMs) ? Math.max(100, options.holdMs) : COPY_HOLD_MS;
  const movementThresholdPx = Number.isFinite(options.movementThresholdPx)
    ? Math.max(2, options.movementThresholdPx)
    : COPY_MOVE_THRESHOLD_PX;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const writeClipboard = options.writeClipboard ?? createClipboardWriter(options);
  const scrollByLines = typeof options.scrollByLines === 'function'
    ? options.scrollByLines
    : (amount) => terminal.scrollLines(amount);
  const useTouchEvents = options.useTouchEvents ?? (
    typeof globalThis !== 'undefined' && typeof globalThis.TouchEvent === 'function'
  );
  let gesture = null;
  let holdTimer = null;
  let statusTimer = null;
  let pendingCopyText = '';
  let disposed = false;

  function syncAccessibleCopyAction() {
    if (accessibleCopyButton) {
      accessibleCopyButton.disabled = !terminal.hasSelection();
    }
  }

  syncAccessibleCopyAction();

  function setStatus(message, mode = 'info', actionLabel = '', ttlMs = null) {
    if (!status || !statusText) {
      return;
    }
    if (statusTimer !== null) {
      clearTimer(statusTimer);
      statusTimer = null;
    }
    statusText.textContent = message;
    status.dataset.mode = mode;
    status.hidden = message === '';
    if (retryButton) {
      retryButton.textContent = actionLabel;
      retryButton.hidden = actionLabel === '';
      retryButton.setAttribute?.('aria-label', actionLabel);
    }
    if (message !== '' && Number.isFinite(ttlMs)) {
      statusTimer = setTimer(() => {
        statusTimer = null;
        status.hidden = true;
        if (retryButton) {
          retryButton.hidden = true;
        }
      }, ttlMs);
    }
  }

  function clearHoldTimer() {
    if (holdTimer !== null) {
      clearTimer(holdTimer);
      holdTimer = null;
    }
  }

  function cellFromClientPoint(clientX, clientY) {
    const rect = host?.getBoundingClientRect?.();
    const viewportY = terminal.buffer.active.viewportY;
    if (
      !rect
      || !Number.isFinite(rect.width)
      || rect.width <= 0
      || !Number.isFinite(rect.height)
      || rect.height <= 0
    ) {
      return { col: 0, row: viewportY, width: 1 };
    }
    const col = clamp(
      Math.floor(((clientX - rect.left) / rect.width) * terminal.cols),
      0,
      Math.max(0, terminal.cols - 1)
    );
    const viewportRow = clamp(
      Math.floor(((clientY - rect.top) / rect.height) * terminal.rows),
      0,
      Math.max(0, terminal.rows - 1)
    );
    const row = clamp(
      viewportY + viewportRow,
      0,
      Math.max(0, terminal.buffer.active.length - 1)
    );
    const line = terminal.buffer.active.getLine?.(row);
    const cellWidth = (cellCol) => {
      const width = Number(line?.getCell?.(cellCol)?.getWidth?.());
      return Number.isInteger(width) ? width : 1;
    };
    let glyphCol = col;
    let glyphWidth = cellWidth(glyphCol);
    if (glyphWidth === 0) {
      for (let previousCol = glyphCol - 1; previousCol >= 0; previousCol -= 1) {
        const previousWidth = cellWidth(previousCol);
        if (previousWidth > 0) {
          if (previousCol + previousWidth > glyphCol) {
            glyphCol = previousCol;
            glyphWidth = previousWidth;
          }
          break;
        }
      }
    }
    return {
      col: glyphCol,
      row,
      width: clamp(glyphWidth, 1, Math.max(1, terminal.cols - glyphCol))
    };
  }

  function selectRangeToCell(currentCell) {
    if (!gesture?.anchorCell || !currentCell) {
      return;
    }
    const cols = Math.max(1, terminal.cols);
    const anchorStart = gesture.anchorCell.row * cols + gesture.anchorCell.col;
    const anchorEnd = anchorStart + gesture.anchorCell.width - 1;
    const currentStart = currentCell.row * cols + currentCell.col;
    const currentEnd = currentStart + currentCell.width - 1;
    const selectionStart = Math.min(anchorStart, currentStart);
    const selectionEnd = Math.max(anchorEnd, currentEnd);
    const startRow = Math.floor(selectionStart / cols);
    const startCol = selectionStart % cols;
    terminal.select(startCol, startRow, selectionEnd - selectionStart + 1);
    gesture.currentCell = currentCell;
    syncAccessibleCopyAction();
  }

  function clearSelectionState({ clearTerminal = true, hideStatus = true } = {}) {
    clearHoldTimer();
    if (gesture?.inputKind === 'pointer' && gesture?.contactId !== null && gesture?.selecting) {
      try {
        surface?.releasePointerCapture?.(gesture.contactId);
      } catch {}
    }
    gesture = null;
    if (clearTerminal) {
      terminal.clearSelection();
    }
    syncAccessibleCopyAction();
    if (hideStatus) {
      setStatus('');
    }
  }

  function beginSelection() {
    if (!gesture || gesture.phase !== 'pending') {
      return;
    }
    holdTimer = null;
    const cell = cellFromClientPoint(gesture.lastX, gesture.lastY);
    gesture.phase = 'selecting';
    gesture.selecting = true;
    gesture.anchorCell = cell;
    selectRangeToCell(cell);
    if (gesture.inputKind === 'pointer') {
      try {
        surface?.setPointerCapture?.(gesture.contactId);
      } catch {}
    }
    setStatus('Release to select', 'selecting');
  }

  async function copyText(text, { retainOnFailure = true, preferSynchronous = false } = {}) {
    if (!text) {
      clearSelectionState();
      return false;
    }
    try {
      await writeClipboard(text, { preferSynchronous });
      pendingCopyText = '';
      clearSelectionState({ clearTerminal: true, hideStatus: false });
      setStatus('Copied', 'success', '', COPY_STATUS_TTL_MS);
      return true;
    } catch {
      pendingCopyText = retainOnFailure ? text : '';
      gesture = null;
      syncAccessibleCopyAction();
      setStatus('Copy failed', 'error', 'Retry');
      return false;
    }
  }

  function isCopyControlTarget(target) {
    return Boolean(
      target
      && (
        target === retryButton
        || retryButton?.contains?.(target)
        || target === accessibleCopyButton
        || accessibleCopyButton?.contains?.(target)
      )
    );
  }

  function dismissPendingCopy() {
    if (!pendingCopyText) {
      return;
    }
    pendingCopyText = '';
    terminal.clearSelection();
    syncAccessibleCopyAction();
    setStatus('');
  }

  function startGesture(contactId, clientX, clientY, inputKind) {
    if (gesture) {
      clearSelectionState();
      return false;
    }
    dismissPendingCopy();
    gesture = {
      contactId,
      inputKind,
      phase: 'pending',
      selecting: false,
      startX: clientX,
      startY: clientY,
      lastX: clientX,
      lastY: clientY,
      anchorCell: null,
      currentCell: null
    };
    holdTimer = setTimer(beginSelection, holdMs);
    return true;
  }

  function moveGesture(event, contactId, clientX, clientY) {
    if (!gesture || contactId !== gesture.contactId) {
      return;
    }
    gesture.lastX = clientX;
    gesture.lastY = clientY;
    if (gesture.phase === 'pending') {
      const distance = Math.hypot(clientX - gesture.startX, clientY - gesture.startY);
      if (distance > movementThresholdPx) {
        clearHoldTimer();
        gesture.phase = 'scrolling';
      }
      return;
    }
    if (gesture.phase !== 'selecting') {
      return;
    }
    event.preventDefault?.();
    const rect = host?.getBoundingClientRect?.();
    if (rect && clientY < rect.top + 12) {
      scrollByLines(-1);
    } else if (rect && clientY > rect.bottom - 12) {
      scrollByLines(1);
    }
    const cell = cellFromClientPoint(clientX, clientY);
    if (
      !gesture.currentCell
      || cell.col !== gesture.currentCell.col
      || cell.row !== gesture.currentCell.row
      || cell.width !== gesture.currentCell.width
    ) {
      selectRangeToCell(cell);
    }
  }

  function finishGesture(event, contactId) {
    if (!gesture || contactId !== gesture.contactId) {
      return false;
    }
    clearHoldTimer();
    if (gesture.phase !== 'selecting') {
      gesture = null;
      return false;
    }
    event.preventDefault?.();
    const text = terminal.getSelection();
    if (!text) {
      clearSelectionState();
      return false;
    }
    pendingCopyText = text;
    clearSelectionState({ clearTerminal: false, hideStatus: false });
    setStatus('Selected', 'ready', 'Copy');
    return true;
  }

  function handlePointerDown(event) {
    if (
      useTouchEvents
      || disposed
      || event.pointerType !== 'touch'
      || event.isPrimary === false
      || isCopyControlTarget(event.target)
    ) {
      if (!useTouchEvents && event.pointerType === 'touch' && gesture) {
        clearSelectionState();
      }
      return;
    }
    startGesture(event.pointerId, event.clientX, event.clientY, 'pointer');
  }

  function handlePointerMove(event) {
    if (useTouchEvents) {
      return;
    }
    moveGesture(event, event.pointerId, event.clientX, event.clientY);
  }

  async function handlePointerUp(event) {
    if (useTouchEvents) {
      return false;
    }
    return finishGesture(event, event.pointerId);
  }

  function handlePointerCancel(event) {
    if (
      !useTouchEvents
      && gesture
      && (event?.pointerId === undefined || event.pointerId === gesture.contactId)
    ) {
      clearSelectionState();
    }
  }

  function touchWithIdentifier(touches, identifier) {
    return Array.from(touches ?? []).find((touch) => touch.identifier === identifier) ?? null;
  }

  function handleTouchStart(event) {
    if (!useTouchEvents || disposed || isCopyControlTarget(event.target)) {
      return;
    }
    if (event.touches?.length !== 1) {
      if (gesture) {
        clearSelectionState();
      }
      return;
    }
    const touch = event.touches[0];
    startGesture(touch.identifier, touch.clientX, touch.clientY, 'touch');
  }

  function handleTouchMove(event) {
    if (!useTouchEvents || !gesture) {
      return;
    }
    if (event.touches?.length !== 1) {
      clearSelectionState();
      return;
    }
    const touch = touchWithIdentifier(event.touches, gesture.contactId);
    if (touch) {
      moveGesture(event, touch.identifier, touch.clientX, touch.clientY);
    }
  }

  async function handleTouchEnd(event) {
    if (!useTouchEvents || !gesture) {
      return false;
    }
    const touch = touchWithIdentifier(event.changedTouches, gesture.contactId);
    if (!touch) {
      return false;
    }
    return finishGesture(event, touch.identifier);
  }

  function handleTouchCancel(event) {
    if (!useTouchEvents || !gesture) {
      return;
    }
    const cancelledTouch = touchWithIdentifier(event?.changedTouches, gesture.contactId);
    if (!event?.changedTouches?.length || cancelledTouch) {
      clearSelectionState();
    }
  }

  async function retryCopy() {
    if (!pendingCopyText) {
      return false;
    }
    return copyText(pendingCopyText);
  }

  async function copyCurrentSelection() {
    return copyText(terminal.getSelection());
  }

  function handleKeyDown(event) {
    if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'c' || !terminal.hasSelection()) {
      return;
    }
    event.preventDefault?.();
    void copyCurrentSelection();
  }

  if (useTouchEvents) {
    surface?.addEventListener?.('touchstart', handleTouchStart, { passive: true });
    surface?.addEventListener?.('touchmove', handleTouchMove, { passive: false });
    surface?.addEventListener?.('touchend', handleTouchEnd, { passive: false });
    surface?.addEventListener?.('touchcancel', handleTouchCancel, { passive: true });
  } else {
    surface?.addEventListener?.('pointerdown', handlePointerDown, { passive: true });
    surface?.addEventListener?.('pointermove', handlePointerMove, { passive: false });
    surface?.addEventListener?.('pointerup', handlePointerUp, { passive: false });
    surface?.addEventListener?.('pointercancel', handlePointerCancel, { passive: true });
  }
  surface?.addEventListener?.('keydown', handleKeyDown);
  retryButton?.addEventListener?.('click', retryCopy);
  accessibleCopyButton?.addEventListener?.('click', copyCurrentSelection);
  const selectionDisposable = terminal.onSelectionChange?.(syncAccessibleCopyAction);

  return {
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    retryCopy,
    copyCurrentSelection,
    get phase() {
      return gesture?.phase ?? 'idle';
    },
    dispose() {
      disposed = true;
      clearSelectionState();
      if (statusTimer !== null) {
        clearTimer(statusTimer);
        statusTimer = null;
      }
      if (useTouchEvents) {
        surface?.removeEventListener?.('touchstart', handleTouchStart);
        surface?.removeEventListener?.('touchmove', handleTouchMove);
        surface?.removeEventListener?.('touchend', handleTouchEnd);
        surface?.removeEventListener?.('touchcancel', handleTouchCancel);
      } else {
        surface?.removeEventListener?.('pointerdown', handlePointerDown);
        surface?.removeEventListener?.('pointermove', handlePointerMove);
        surface?.removeEventListener?.('pointerup', handlePointerUp);
        surface?.removeEventListener?.('pointercancel', handlePointerCancel);
      }
      surface?.removeEventListener?.('keydown', handleKeyDown);
      retryButton?.removeEventListener?.('click', retryCopy);
      accessibleCopyButton?.removeEventListener?.('click', copyCurrentSelection);
      selectionDisposable?.dispose?.();
    }
  };
}

export function createOperatorTerminalView(options = {}) {
  const root = options.root;
  const host = options.host;
  const scrollSpacer = options.scrollSpacer ?? null;
  if (!root || !host) {
    throw new Error('terminal root and host are required');
  }
  const sendPayload = typeof options.sendPayload === 'function' ? options.sendPayload : () => false;
  const decodePayload = typeof options.decodePayload === 'function'
    ? options.decodePayload
    : decodeTerminalPayloadBytes;
  const gzipSupported = options.gzipSupported === true
    || (options.gzipSupported !== false && supportsGzipDecompression());
  const TerminalClass = options.TerminalClass;
  if (typeof TerminalClass !== 'function') {
    throw new Error('TerminalClass is required');
  }
  const terminal = new TerminalClass({
    cols: 80,
    rows: 24,
    scrollback: DEFAULT_SCROLLBACK,
    disableStdin: true,
    cursorBlink: false,
    cursorStyle: 'block',
    allowTransparency: true,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    fontSize: DEFAULT_FONT_SIZE,
    lineHeight: 1.18,
    convertEol: false,
    allowProposedApi: false,
    theme: {
      background: 'rgba(2, 8, 14, 0)',
      foreground: '#f2f8ff',
      cursor: '#91ffe7',
      selectionBackground: '#2b6175',
      selectionInactiveBackground: '#244653'
    }
  });
  terminal.open(host);
  const copyGesture = createTerminalCopyGesture({
    surface: root,
    host,
    terminal,
    status: options.copyStatus,
    statusText: options.copyStatusText,
    retryButton: options.copyRetryButton,
    accessibleCopyButton: options.accessibleCopyButton,
    clipboard: options.clipboard,
    documentRef: options.documentRef,
    useTouchEvents: options.useTouchEvents,
    scrollByLines: scrollSelectionByLines
  });
  let sessionId = asNonEmptyString(options.sessionId) ?? DEFAULT_SESSION_ID;
  let pane = null;
  let generation = null;
  let expectedSequence = null;
  let connected = false;
  let visible = false;
  let subscribed = false;
  let resyncPending = false;
  let disposed = false;
  let writeEpoch = 0;
  let writeQueue = Promise.resolve();
  let fontScale = 1;
  let terminalHeightObserver = null;

  function syncTerminalRenderedHeight() {
    if (disposed) {
      return;
    }
    const renderedHeight = Number(host.getBoundingClientRect?.().height);
    if (!Number.isFinite(renderedHeight) || renderedHeight <= 0) {
      return;
    }
    root.style?.setProperty?.(
      '--operator-terminal-render-height',
      `${Math.ceil(renderedHeight)}px`
    );
  }

  syncTerminalRenderedHeight();
  const ResizeObserverClass = options.ResizeObserverClass === undefined
    ? globalThis.ResizeObserver
    : options.ResizeObserverClass;

  const useNativeScrollProxy = Boolean(
    scrollSpacer
    && (
      options.useNativeScrollProxy === true
      || (
        options.useNativeScrollProxy !== false
        && (
          globalThis.matchMedia?.('(any-pointer: coarse)')?.matches
          || Number(globalThis.navigator?.maxTouchPoints) > 0
        )
      )
    )
  );
  let syncingNativeScroll = false;
  let nativeScrollCellHeight = 1;
  let nativeAutoFollow = true;
  let nativeScrollInteractionActive = false;
  let nativeScrollContactActive = false;
  let nativeScrollInteractionTimer = null;
  let nativeFollowFrame = null;
  let nativeInteractionScrollTop = 0;
  let parsingTerminalOutput = false;
  let remoteContact = null;
  let wheelRemainder = 0;
  let sourceScrollReady = false;
  const useNativeTouchEvents = options.useTouchEvents ?? (
    typeof globalThis !== 'undefined' && typeof globalThis.TouchEvent === 'function'
  );
  const scheduleTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
  const cancelTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  const requestFrame = options.requestFrame
    ?? globalThis.requestAnimationFrame?.bind(globalThis)
    ?? ((callback) => scheduleTimer(callback, 0));
  const cancelFrame = options.cancelFrame
    ?? globalThis.cancelAnimationFrame?.bind(globalThis)
    ?? cancelTimer;

  function measureNativeScrollCellHeight() {
    const rowHeight = Number(host.querySelector?.('.xterm-rows > div')?.getBoundingClientRect?.().height);
    if (Number.isFinite(rowHeight) && rowHeight > 0) {
      nativeScrollCellHeight = rowHeight;
      return rowHeight;
    }
    const hostHeight = Number(host.getBoundingClientRect?.().height);
    if (Number.isFinite(hostHeight) && hostHeight > 0 && terminal.rows > 0) {
      nativeScrollCellHeight = hostHeight / terminal.rows;
    }
    return nativeScrollCellHeight;
  }

  function measureNativeScrollViewportSlack() {
    const rootStyle = globalThis.getComputedStyle?.(root);
    const paddingTop = Number.parseFloat(rootStyle?.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(rootStyle?.paddingBottom) || 0;
    const rootContentHeight = Math.max(
      0,
      (Number(root.clientHeight) || 0) - paddingTop - paddingBottom
    );
    const hostHeight = Number(host.getBoundingClientRect?.().height) || 0;
    return Math.max(0, rootContentHeight - hostHeight);
  }

  // The bottom-most row that actually carries something. A pane whose output
  // does not fill the screen (a freshly started shell, for example) leaves the
  // rows below the cursor blank, and following the grid bottom would park the
  // viewport on that blank space with the real content scrolled out of sight.
  function measureNativeContentBottomRow() {
    const buffer = terminal.buffer?.active;
    const lastRow = Math.max(0, terminal.rows - 1);
    if (!buffer || typeof buffer.getLine !== 'function') {
      return lastRow;
    }
    const baseY = Math.max(0, Number(buffer.baseY) || 0);
    const cursorRow = Number.isFinite(buffer.cursorY) ? Math.max(0, Math.min(lastRow, buffer.cursorY)) : null;
    let lastFilledRow = null;
    for (let row = lastRow; row >= 0; row -= 1) {
      const line = buffer.getLine(baseY + row);
      if (typeof line?.translateToString !== 'function') {
        // Unknown buffer shape: keep the historical "follow the grid" behaviour.
        return lastRow;
      }
      if (line.translateToString(true).trim() !== '') {
        lastFilledRow = row;
        break;
      }
    }
    if (cursorRow === null && lastFilledRow === null) {
      return lastRow;
    }
    return Math.max(cursorRow ?? 0, lastFilledRow ?? 0);
  }

  function computeNativeTailScrollTop() {
    if (!useNativeScrollProxy) {
      return 0;
    }
    const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
    const cellHeight = measureNativeScrollCellHeight();
    const baseY = Math.max(0, Number(terminal.buffer.active.baseY) || 0);
    const contentBottomPx = (baseY + measureNativeContentBottomRow() + 1) * cellHeight;
    return Math.max(0, Math.min(maxScrollTop, Math.ceil(contentBottomPx - root.clientHeight)));
  }

  function isNativeScrollNearBottom() {
    if (!useNativeScrollProxy) {
      return false;
    }
    const remaining = Math.max(0, computeNativeTailScrollTop() - root.scrollTop);
    return remaining <= Math.max(2, measureNativeScrollCellHeight() * 1.5);
  }

  function clearNativeScrollInteractionTimer() {
    if (nativeScrollInteractionTimer !== null) {
      cancelTimer(nativeScrollInteractionTimer);
      nativeScrollInteractionTimer = null;
    }
  }

  function settleNativeScrollInteractionSoon() {
    clearNativeScrollInteractionTimer();
    nativeScrollInteractionTimer = scheduleTimer(() => {
      nativeScrollInteractionTimer = null;
      if (!nativeScrollContactActive) {
        nativeScrollInteractionActive = false;
      }
    }, 240);
  }

  function beginNativeScrollInteraction() {
    if (!useNativeScrollProxy || disposed) {
      return;
    }
    clearNativeScrollInteractionTimer();
    nativeScrollContactActive = true;
    nativeScrollInteractionActive = true;
    nativeInteractionScrollTop = Math.max(0, Number(root.scrollTop) || 0);
  }

  function endNativeScrollInteraction() {
    if (!useNativeScrollProxy || disposed) {
      return;
    }
    nativeScrollContactActive = false;
    settleNativeScrollInteractionSoon();
    if (nativeAutoFollow) {
      applyNativeTailPosition();
      scheduleNativeTailPosition();
    }
  }

  function sourceAcceptsScroll() {
    const mode = terminal.modes?.mouseTrackingMode;
    return sourceScrollReady && subscribed && connected && !resyncPending && pane !== null && generation !== null
      && (mode === 'vt200' || mode === 'drag' || mode === 'any');
  }

  function sendSourceScroll(lines, clientX, clientY) {
    if (!sourceAcceptsScroll() || !Number.isFinite(lines) || lines === 0) return false;
    const rect = host.getBoundingClientRect();
    const cellHeight = measureNativeScrollCellHeight();
    const x = clamp(Math.floor(((clientX ?? rect.left + rect.width / 2) - rect.left) / (rect.width / terminal.cols)) + 1, 1, terminal.cols);
    const y = clamp(Math.floor(((clientY ?? rect.top + rect.height / 2) - rect.top) / cellHeight) + 1, 1, terminal.rows);
    return emit('operator_terminal_scroll', { lines: clamp(Math.trunc(lines), -100, 100), x, y });
  }

  function updateSourceScrollMode() {
    // Leave horizontal movement and pinch available; vertical movement becomes
    // the same wheel report the PC terminal sends when the program requests it.
    root.style.touchAction = sourceAcceptsScroll() ? 'pan-x pinch-zoom' : '';
  }

  function consumeVisibleGridScroll(pixels) {
    if (!useNativeScrollProxy) return pixels;
    const previous = Number(root.scrollTop) || 0;
    const maximum = Math.max(0, root.scrollHeight - root.clientHeight);
    root.scrollTop = clamp(previous + pixels, 0, maximum);
    if (pixels < 0) nativeAutoFollow = false;
    syncTerminalFromNativeScroll();
    // A compact mobile frame may show only part of the source screen. Read
    // that part locally first; at either edge continue into source scrolling.
    return pixels - (root.scrollTop - previous);
  }

  function scrollSourceOrGrid(lines, clientX, clientY) {
    const cellHeight = measureNativeScrollCellHeight();
    const remaining = consumeVisibleGridScroll(lines * cellHeight);
    const reports = Math.trunc(remaining / cellHeight);
    return reports === 0 || sendSourceScroll(reports, clientX, clientY);
  }

  function startSourceTouch(event) {
    remoteContact = null;
    if (!sourceAcceptsScroll() || event.touches?.length !== 1) return;
    const touch = event.touches[0];
    remoteContact = { id: touch.identifier, startY: touch.clientY, lastY: touch.clientY, remainder: 0, moving: false };
  }

  function moveSourceTouch(event) {
    if (!remoteContact) return;
    if (event.touches?.length !== 1 || !sourceAcceptsScroll() || copyGesture.phase === 'selecting') {
      remoteContact = null;
      return;
    }
    const touch = Array.from(event.touches).find((value) => value.identifier === remoteContact.id);
    if (!touch) return;
    if (!remoteContact.moving && Math.abs(touch.clientY - remoteContact.startY) < COPY_MOVE_THRESHOLD_PX) return;
    remoteContact.moving = true;
    event.preventDefault?.();
    remoteContact.remainder += consumeVisibleGridScroll(remoteContact.lastY - touch.clientY);
    remoteContact.lastY = touch.clientY;
    const cellHeight = measureNativeScrollCellHeight();
    const lines = Math.trunc(remoteContact.remainder / cellHeight);
    if (lines !== 0) {
      sendSourceScroll(lines, touch.clientX, touch.clientY);
      remoteContact.remainder -= lines * cellHeight;
    }
  }

  function endSourceTouch() { remoteContact = null; }

  function handleNativeWheel(event) {
    if (sourceAcceptsScroll() && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault?.();
      event.stopPropagation?.();
      const unit = event.deltaMode === 1 ? measureNativeScrollCellHeight()
        : event.deltaMode === 2 ? terminal.rows * measureNativeScrollCellHeight() : 1;
      wheelRemainder += consumeVisibleGridScroll((Number(event.deltaY) || 0) * unit);
      const lines = Math.trunc(wheelRemainder / measureNativeScrollCellHeight());
      if (lines !== 0) {
        sendSourceScroll(lines, event.clientX, event.clientY);
        wheelRemainder -= lines * measureNativeScrollCellHeight();
      }
      return;
    }
    if (!useNativeScrollProxy || disposed) {
      return;
    }
    nativeScrollInteractionActive = true;
    nativeScrollContactActive = false;
    nativeInteractionScrollTop = Math.max(0, Number(root.scrollTop) || 0);
    settleNativeScrollInteractionSoon();
  }

  function syncTerminalFromNativeScroll() {
    if (!useNativeScrollProxy || disposed) {
      return;
    }
    const cellHeight = measureNativeScrollCellHeight();
    const baseY = Math.max(0, Number(terminal.buffer.active.baseY) || 0);
    const scrollTop = Math.max(0, Number(root.scrollTop) || 0);
    const maxScrollTop = Math.max(0, root.scrollHeight - root.clientHeight);
    const atScrollEnd = maxScrollTop - scrollTop <= Math.max(1, cellHeight * 0.1);
    const viewportY = atScrollEnd
      ? baseY
      : clamp(Math.floor(scrollTop / cellHeight), 0, baseY);
    const remainder = Math.max(0, scrollTop - viewportY * cellHeight);
    syncingNativeScroll = true;
    terminal.scrollToLine(viewportY);
    syncingNativeScroll = false;
    host.style.transform = remainder > 0.01 ? `translateY(${-remainder}px)` : '';
  }

  function scrollSelectionByLines(amount) {
    const lines = Math.trunc(Number(amount) || 0);
    if (lines === 0) {
      return;
    }
    if (!useNativeScrollProxy) {
      terminal.scrollLines(lines);
      return;
    }
    root.scrollTop += lines * measureNativeScrollCellHeight();
    syncTerminalFromNativeScroll();
    nativeAutoFollow = isNativeScrollNearBottom();
  }

  function applyNativeTailPosition() {
    if (!useNativeScrollProxy || disposed || !nativeAutoFollow || nativeScrollContactActive) {
      return;
    }
    root.scrollTop = computeNativeTailScrollTop();
    syncTerminalFromNativeScroll();
  }

  function scheduleNativeTailPosition() {
    if (!useNativeScrollProxy || disposed || !nativeAutoFollow || nativeScrollContactActive || nativeFollowFrame !== null) {
      return;
    }
    nativeFollowFrame = requestFrame(() => {
      nativeFollowFrame = null;
      applyNativeTailPosition();
    });
  }

  function syncNativeScrollSize({ followBottom = false } = {}) {
    if (!useNativeScrollProxy || disposed) {
      return;
    }
    const cellHeight = measureNativeScrollCellHeight();
    const baseY = Math.max(0, Number(terminal.buffer.active.baseY) || 0);
    const viewportSlack = measureNativeScrollViewportSlack();
    scrollSpacer.style.height = `${baseY * cellHeight + viewportSlack}px`;
    if (followBottom) {
      nativeAutoFollow = true;
      if (nativeScrollContactActive) {
        syncTerminalFromNativeScroll();
        return;
      }
      applyNativeTailPosition();
      scheduleNativeTailPosition();
      return;
    }
    syncTerminalFromNativeScroll();
  }

  function handleNativeScroll() {
    const nearBottom = isNativeScrollNearBottom();
    if (nativeScrollInteractionActive) {
      const currentTop = Math.max(0, Number(root.scrollTop) || 0);
      // Even a small deliberate upward drag must escape follow-tail. The usual
      // near-bottom tolerance otherwise pulls it back before the finger can move.
      if (currentTop < nativeInteractionScrollTop - 0.5) {
        nativeAutoFollow = false;
      } else if (currentTop > nativeInteractionScrollTop + 0.5 && nearBottom) {
        nativeAutoFollow = true;
      }
      nativeInteractionScrollTop = currentTop;
      if (!nativeScrollContactActive) {
        settleNativeScrollInteractionSoon();
      }
    } else if (nativeAutoFollow && !nearBottom) {
      applyNativeTailPosition();
      scheduleNativeTailPosition();
      return;
    }
    syncTerminalFromNativeScroll();
  }

  if (useNativeScrollProxy) {
    root.classList?.add?.('operator-native-scroll-proxy');
    root.addEventListener?.('scroll', handleNativeScroll, { passive: true });
    if (useNativeTouchEvents) {
      root.addEventListener?.('touchstart', beginNativeScrollInteraction, { passive: true });
      root.addEventListener?.('touchend', endNativeScrollInteraction, { passive: true });
      root.addEventListener?.('touchcancel', endNativeScrollInteraction, { passive: true });
    } else {
      root.addEventListener?.('pointerdown', beginNativeScrollInteraction, { passive: true });
      root.addEventListener?.('pointerup', endNativeScrollInteraction, { passive: true });
      root.addEventListener?.('pointercancel', endNativeScrollInteraction, { passive: true });
    }
  }

  root.addEventListener?.('wheel', handleNativeWheel, { passive: false, capture: true });
  if (useNativeTouchEvents) {
    root.addEventListener?.('touchstart', startSourceTouch, { passive: true });
    root.addEventListener?.('touchmove', moveSourceTouch, { passive: false });
    root.addEventListener?.('touchend', endSourceTouch, { passive: true });
    root.addEventListener?.('touchcancel', endSourceTouch, { passive: true });
  }

  if (typeof ResizeObserverClass === 'function') {
    terminalHeightObserver = new ResizeObserverClass(() => {
      const followBottom = useNativeScrollProxy && nativeAutoFollow;
      syncTerminalRenderedHeight();
      syncNativeScrollSize({ followBottom });
    });
    terminalHeightObserver.observe(host);
    if (useNativeScrollProxy) {
      terminalHeightObserver.observe(root);
    }
  }

  function emit(type, extra = {}) {
    return sendPayload({
      v: 1,
      type,
      session_id: sessionId,
      pane,
      generation,
      seq: expectedSequence,
      ts: Date.now(),
      ...extra
    });
  }

  function syncSubscription() {
    const shouldSubscribe = connected && visible && !disposed;
    if (shouldSubscribe === subscribed) {
      return;
    }
    subscribed = shouldSubscribe;
    sourceScrollReady = false;
    endSourceTouch();
    updateSourceScrollMode();
    if (subscribed) {
      resyncPending = false;
      emit('operator_terminal_subscribe', {
        data_encodings: gzipSupported ? ['gzip-base64', 'base64'] : ['base64']
      });
    } else {
      emit('operator_terminal_unsubscribe');
    }
  }

  function scheduleWrite(bytesSource, message, epoch = writeEpoch, reset = false, acknowledge = true, resetFollow = reset) {
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      if (disposed || epoch !== writeEpoch) {
        return;
      }
      const bytes = typeof bytesSource === 'function' ? await bytesSource() : bytesSource;
      if (disposed || epoch !== writeEpoch) {
        return;
      }
      parsingTerminalOutput = true;
      try {
        if (reset) {
          terminal.reset();
          terminal.resize(message.cols, message.rows);
        }
        await new Promise((resolve) => {
          terminal.write(bytes, () => {
            if (reset && !disposed && epoch === writeEpoch) sourceScrollReady = true;
            // Consult the current reader intent, not the state when parsing began.
            const followNativeScroll = useNativeScrollProxy && (resetFollow || nativeAutoFollow);
            syncTerminalRenderedHeight();
            syncNativeScrollSize({ followBottom: followNativeScroll });
            updateSourceScrollMode();
            if (!disposed && epoch === writeEpoch && acknowledge) {
              emit('operator_terminal_ack', {
                pane: message.pane,
                generation: message.generation,
                seq: message.seq
              });
            }
            resolve();
          });
        });
      } finally {
        parsingTerminalOutput = false;
      }
    });
    return writeQueue;
  }

  function requestResync() {
    if (resyncPending || !subscribed) {
      return false;
    }
    resyncPending = true;
    endSourceTouch();
    updateSourceScrollMode();
    emit('operator_terminal_resync');
    return true;
  }

  function handleReset(message) {
    if (!subscribed || asNonEmptyString(message?.session_id) !== sessionId) {
      return false;
    }
    const nextPane = asNonEmptyString(message.pane);
    const nextGeneration = Number(message.generation);
    const nextSequence = Number(message.seq);
    const cols = Number(message.cols);
    const rows = Number(message.rows);
    if (
      !nextPane
      || !Number.isSafeInteger(nextGeneration)
      || !Number.isSafeInteger(nextSequence)
      || !Number.isInteger(cols)
      || !Number.isInteger(rows)
    ) {
      return false;
    }
    const resetFollow = pane !== nextPane;
    sourceScrollReady = false;
    endSourceTouch();
    wheelRemainder = 0;
    if (resetFollow) {
      copyGesture.handleTouchCancel({});
      copyGesture.handlePointerCancel({});
    }
    updateSourceScrollMode();
    pane = nextPane;
    generation = nextGeneration;
    expectedSequence = nextSequence;
    resyncPending = false;
    writeEpoch += 1;
    const epoch = writeEpoch;
    const pendingWrite = scheduleWrite(() => decodePayload(message), {
      ...message,
      cols: clamp(cols, 2, 1000),
      rows: clamp(rows, 1, 1000)
    }, epoch, true, true, resetFollow);
    void pendingWrite.catch(() => requestResync());
    return pendingWrite;
  }

  function handleData(message) {
    if (!subscribed || resyncPending || asNonEmptyString(message?.session_id) !== sessionId) {
      return false;
    }
    const nextSequence = Number(message.seq);
    if (
      message.pane !== pane
      || Number(message.generation) !== generation
      || !Number.isSafeInteger(nextSequence)
      || nextSequence !== expectedSequence + 1
    ) {
      requestResync();
      return false;
    }
    expectedSequence = nextSequence;
    const pendingWrite = scheduleWrite(() => decodePayload(message), message);
    void pendingWrite.catch(() => requestResync());
    return pendingWrite;
  }

  const scrollDisposable = terminal.onScroll?.((viewportY) => {
    if (!useNativeScrollProxy || syncingNativeScroll || parsingTerminalOutput || disposed) {
      return;
    }
    const buffer = terminal.buffer.active;
    if (nativeAutoFollow && buffer.baseY - Number(viewportY) > 1) {
      scheduleNativeTailPosition();
      return;
    }
    const cellHeight = measureNativeScrollCellHeight();
    root.scrollTop = Math.max(0, Number(viewportY) || 0) * cellHeight;
    syncTerminalFromNativeScroll();
  });

  return {
    terminal,
    socketOpen() {
      connected = true;
      syncSubscription();
    },
    socketClose() {
      connected = false;
      sourceScrollReady = false;
      subscribed = false;
      resyncPending = false;
      endSourceTouch();
      updateSourceScrollMode();
    },
    setVisible(nextVisible) {
      visible = nextVisible === true;
      syncSubscription();
    },
    setSession(nextSessionId) {
      const normalized = asNonEmptyString(nextSessionId) ?? DEFAULT_SESSION_ID;
      if (normalized === sessionId) {
        return;
      }
      if (subscribed) {
        emit('operator_terminal_unsubscribe');
        subscribed = false;
      }
      sessionId = normalized;
      pane = null;
      generation = null;
      expectedSequence = null;
      syncSubscription();
    },
    handleReset,
    handleData,
    handleSnapshot(message) {
      if (!Array.isArray(message?.lines)) {
        return false;
      }
      pane = asNonEmptyString(message.pane) ?? pane;
      generation = null;
      expectedSequence = null;
      resyncPending = false;
      writeEpoch += 1;
      const epoch = writeEpoch;
      const text = message.lines.map((line) => String(line)).join('\r\n');
      return scheduleWrite(
        new TextEncoder().encode(text),
        { pane, generation: null, seq: null, cols: terminal.cols, rows: terminal.rows },
        epoch,
        true,
        false
      );
    },
    handleError(message) {
      if (options.copyStatus && options.copyStatusText) {
        options.copyStatusText.textContent = `terminal: ${asNonEmptyString(message?.reason) ?? 'stream error'}`;
        options.copyStatus.dataset.mode = 'error';
        options.copyStatus.hidden = false;
        if (options.copyRetryButton) {
          options.copyRetryButton.hidden = true;
        }
      }
    },
    scrollLines(amount) {
      if (sourceAcceptsScroll()) return scrollSourceOrGrid(amount);
      scrollSelectionByLines(amount);
      return true;
    },
    scrollPages(direction) {
      if (sourceAcceptsScroll()) return scrollSourceOrGrid(Math.sign(direction) * Math.max(1, Math.floor(root.clientHeight / measureNativeScrollCellHeight()) - 1));
      if (useNativeScrollProxy) {
        root.scrollTop += Math.sign(direction) * Math.max(1, root.clientHeight);
        syncTerminalFromNativeScroll();
        nativeAutoFollow = isNativeScrollNearBottom();
        if (nativeAutoFollow) {
          scheduleNativeTailPosition();
        }
        return true;
      }
      terminal.scrollPages(direction);
      return true;
    },
    scrollToBottom() {
      if (useNativeScrollProxy) {
        nativeAutoFollow = true;
        applyNativeTailPosition();
        scheduleNativeTailPosition();
        return;
      }
      terminal.scrollToBottom();
    },
    setFontScale(nextScale) {
      const followBottom = useNativeScrollProxy && nativeAutoFollow;
      fontScale = clamp(Number(nextScale) || 1, 0.6, 2.4);
      terminal.options.fontSize = DEFAULT_FONT_SIZE * fontScale;
      terminal.refresh?.(0, terminal.rows - 1);
      syncTerminalRenderedHeight();
      syncNativeScrollSize({ followBottom });
      return fontScale;
    },
    getFontScale() {
      return fontScale;
    },
    getPane() {
      return pane;
    },
    isNearBottom() {
      if (useNativeScrollProxy) {
        return isNativeScrollNearBottom();
      }
      const buffer = terminal.buffer.active;
      return buffer.baseY - buffer.viewportY <= 1;
    },
    async whenWritesComplete() {
      await writeQueue;
    },
    dispose() {
      if (subscribed) {
        emit('operator_terminal_unsubscribe');
      }
      disposed = true;
      subscribed = false;
      writeEpoch += 1;
      terminalHeightObserver?.disconnect?.();
      terminalHeightObserver = null;
      clearNativeScrollInteractionTimer();
      if (nativeFollowFrame !== null) {
        cancelFrame(nativeFollowFrame);
        nativeFollowFrame = null;
      }
      root.style?.removeProperty?.('--operator-terminal-render-height');
      copyGesture.dispose();
      root.removeEventListener?.('wheel', handleNativeWheel, { capture: true });
      root.removeEventListener?.('touchstart', startSourceTouch);
      root.removeEventListener?.('touchmove', moveSourceTouch);
      root.removeEventListener?.('touchend', endSourceTouch);
      root.removeEventListener?.('touchcancel', endSourceTouch);
      root.style.touchAction = '';
      if (useNativeScrollProxy) {
        root.removeEventListener?.('scroll', handleNativeScroll);
        if (useNativeTouchEvents) {
          root.removeEventListener?.('touchstart', beginNativeScrollInteraction);
          root.removeEventListener?.('touchend', endNativeScrollInteraction);
          root.removeEventListener?.('touchcancel', endNativeScrollInteraction);
        } else {
          root.removeEventListener?.('pointerdown', beginNativeScrollInteraction);
          root.removeEventListener?.('pointerup', endNativeScrollInteraction);
          root.removeEventListener?.('pointercancel', endNativeScrollInteraction);
        }
        root.classList?.remove?.('operator-native-scroll-proxy');
        host.style.transform = '';
        scrollSpacer.style.height = '0px';
      }
      scrollDisposable?.dispose?.();
      terminal.dispose();
    }
  };
}
