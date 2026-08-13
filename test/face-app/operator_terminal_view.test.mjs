import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  createOperatorTerminalView,
  createTerminalCopyGesture,
  decodeTerminalPayloadBytes
} from '../../face-app/public/operator_terminal_view.js';

class FakeElement extends EventTarget {
  constructor(rect = { top: 0, bottom: 100, left: 0, width: 200, height: 100 }) {
    super();
    this.hidden = true;
    this.dataset = {};
    this.textContent = '';
    this.rect = rect;
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      removeProperty(name) {
        delete this[name];
      }
    };
    this.clientHeight = rect.height;
    this.scrollHeight = rect.height;
    this.scrollTop = 0;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setPointerCapture() {}
  releasePointerCapture() {}
}

class FakeTerminal {
  constructor(options) {
    this.options = { ...options };
    this.cols = options.cols;
    this.rows = options.rows;
    this.writes = [];
    this.resetCount = 0;
    this.selection = '';
    this.selectedLines = [];
    this.selectedRanges = [];
    this.cellWidths = new Map();
    this.buffer = {
      active: {
        viewportY: 0,
        baseY: 0,
        length: 40,
        getLine: (row) => ({
          getCell: (col) => ({
            getWidth: () => this.cellWidths.get(`${row}:${col}`) ?? 1
          })
        })
      }
    };
  }

  open(host) {
    this.host = host;
  }

  write(bytes, callback) {
    this.writes.push(Buffer.from(bytes).toString('utf8'));
    callback?.();
  }

  reset() {
    this.resetCount += 1;
    this.writes = [];
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  selectLines(start, end) {
    this.selectedLines.push([start, end]);
    this.selection = Array.from({ length: end - start + 1 }, (_, index) => `line-${start + index}`).join('\n');
  }

  select(col, row, length) {
    this.selectedRanges.push([col, row, length]);
    this.selection = `range-${col}-${row}-${length}`;
  }

  getSelection() {
    return this.selection;
  }

  hasSelection() {
    return this.selection !== '';
  }

  clearSelection() {
    this.selection = '';
  }

  scrollLines(amount) {
    this.buffer.active.viewportY = Math.max(0, this.buffer.active.viewportY + amount);
  }

  scrollToLine(line) {
    this.buffer.active.viewportY = Math.max(0, line);
  }

  scrollPages() {}
  scrollToBottom() {}
  onScroll() { return { dispose() {} }; }
  dispose() {}
}

function createFakeTimers() {
  let nextId = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) {
      const id = nextId;
      nextId += 1;
      callbacks.set(id, callback);
      return id;
    },
    clearTimer(id) {
      callbacks.delete(id);
    },
    runNext() {
      const next = callbacks.entries().next().value;
      if (!next) {
        return false;
      }
      callbacks.delete(next[0]);
      next[1]();
      return true;
    }
  };
}

function touchEvent(overrides = {}) {
  return {
    pointerType: 'touch',
    isPrimary: true,
    pointerId: 1,
    clientX: 50,
    clientY: 20,
    preventDefault() {},
    ...overrides
  };
}

function touchPoint(overrides = {}) {
  return {
    identifier: 1,
    clientX: 50,
    clientY: 20,
    ...overrides
  };
}

function touchListEvent({ touches = [], changedTouches = [], preventDefault = () => {} } = {}) {
  return { touches, changedTouches, preventDefault };
}

test('browser terminal payload decoder inflates negotiated gzip bytes', async () => {
  const raw = Buffer.from('compressed terminal redraw '.repeat(20));
  const decoded = await decodeTerminalPayloadBytes({
    data_encoding: 'gzip-base64',
    data_base64: gzipSync(raw).toString('base64'),
    data_uncompressed_bytes: raw.length
  });
  assert.deepEqual(Buffer.from(decoded), raw);
});

test('terminal view publishes its rendered height and uses a transparent canvas', () => {
  const root = new FakeElement();
  const host = new FakeElement({ top: 0, bottom: 558, left: 0, width: 500, height: 558 });
  const view = createOperatorTerminalView({
    root,
    host,
    TerminalClass: FakeTerminal,
    ResizeObserverClass: null
  });

  assert.equal(view.terminal.options.allowTransparency, true);
  assert.equal(view.terminal.options.theme.background, 'rgba(2, 8, 14, 0)');
  assert.equal(root.style['--operator-terminal-render-height'], '558px');

  host.rect = { top: 0, bottom: 666, left: 0, width: 500, height: 666 };
  view.setFontScale(1.2);
  assert.equal(root.style['--operator-terminal-render-height'], '666px');

  view.dispose();
  assert.equal(root.style['--operator-terminal-render-height'], undefined);
});

test('pointer fallback selects across rows and release offers a contextual Copy action', async () => {
  const timers = createFakeTimers();
  const surface = new FakeElement();
  const host = new FakeElement();
  const status = new FakeElement();
  const statusText = new FakeElement();
  const retry = new FakeElement();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  terminal.buffer.active.viewportY = 5;
  const copied = [];
  const gesture = createTerminalCopyGesture({
    surface,
    host,
    terminal,
    status,
    statusText,
    retryButton: retry,
    useTouchEvents: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    writeClipboard: async (text) => copied.push(text)
  });

  gesture.handlePointerDown(touchEvent());
  assert.equal(gesture.phase, 'pending');
  timers.runNext();
  assert.equal(gesture.phase, 'selecting');
  assert.equal(statusText.textContent, 'Release to select');
  assert.deepEqual(terminal.selectedRanges[0], [5, 6, 1]);

  gesture.handlePointerMove(touchEvent({ clientX: 150, clientY: 80 }));
  assert.deepEqual(terminal.selectedRanges.at(-1), [5, 6, 71]);
  await gesture.handlePointerUp(touchEvent({ clientX: 150, clientY: 80 }));
  assert.deepEqual(copied, []);
  assert.equal(gesture.phase, 'idle');
  assert.equal(statusText.textContent, 'Selected');
  assert.equal(retry.textContent, 'Copy');
  assert.equal(retry.hidden, false);
  assert.equal(terminal.hasSelection(), true);

  await gesture.retryCopy();
  assert.deepEqual(copied, ['range-5-6-71']);
  assert.equal(statusText.textContent, 'Copied');
  assert.equal(retry.hidden, true);
  assert.equal(terminal.hasSelection(), false);
  gesture.dispose();
});

test('pre-threshold movement locks the entire pointer sequence into scrolling', async () => {
  const timers = createFakeTimers();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  let copyCount = 0;
  const gesture = createTerminalCopyGesture({
    surface: new FakeElement(),
    host: new FakeElement(),
    terminal,
    useTouchEvents: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    writeClipboard: async () => { copyCount += 1; }
  });

  gesture.handlePointerDown(touchEvent());
  gesture.handlePointerMove(touchEvent({ clientY: 35 }));
  assert.equal(gesture.phase, 'scrolling');
  assert.equal(timers.runNext(), false);
  gesture.handlePointerMove(touchEvent({ clientY: 20 }));
  await gesture.handlePointerUp(touchEvent());
  assert.equal(copyCount, 0);
  assert.deepEqual(terminal.selectedRanges, []);
  gesture.dispose();
});

test('second touch cancels selection and a failed contextual copy becomes Retry', async () => {
  const timers = createFakeTimers();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  const status = new FakeElement();
  const statusText = new FakeElement();
  const retry = new FakeElement();
  let fail = true;
  const copied = [];
  const gesture = createTerminalCopyGesture({
    surface: new FakeElement(),
    host: new FakeElement(),
    terminal,
    status,
    statusText,
    retryButton: retry,
    useTouchEvents: false,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    writeClipboard: async (text) => {
      if (fail) throw new Error('denied');
      copied.push(text);
    }
  });

  gesture.handlePointerDown(touchEvent());
  timers.runNext();
  gesture.handlePointerDown(touchEvent({ pointerId: 2, isPrimary: false }));
  assert.equal(gesture.phase, 'idle');
  assert.equal(terminal.getSelection(), '');

  gesture.handlePointerDown(touchEvent());
  timers.runNext();
  await gesture.handlePointerUp(touchEvent());
  assert.equal(retry.hidden, false);
  assert.equal(retry.textContent, 'Copy');
  assert.equal(statusText.textContent, 'Selected');

  await gesture.retryCopy();
  assert.equal(retry.hidden, false);
  assert.equal(retry.textContent, 'Retry');
  assert.equal(statusText.textContent, 'Copy failed');
  fail = false;
  await gesture.retryCopy();
  assert.deepEqual(copied, ['range-5-1-1']);
  assert.equal(retry.hidden, true);
  gesture.dispose();
});

test('touch path preserves native scrolling before hold and claims only an armed selection drag', async () => {
  const timers = createFakeTimers();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  const copied = [];
  let prevented = 0;
  const gesture = createTerminalCopyGesture({
    surface: new FakeElement(),
    host: new FakeElement(),
    terminal,
    useTouchEvents: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    writeClipboard: async (text) => copied.push(text)
  });
  const first = touchPoint();

  gesture.handleTouchStart(touchListEvent({ touches: [first] }));
  gesture.handleTouchMove(touchListEvent({
    touches: [touchPoint({ clientY: 35 })],
    preventDefault: () => { prevented += 1; }
  }));
  assert.equal(gesture.phase, 'scrolling');
  assert.equal(prevented, 0);
  assert.equal(timers.runNext(), false);
  await gesture.handleTouchEnd(touchListEvent({ changedTouches: [touchPoint({ clientY: 35 })] }));

  gesture.handleTouchStart(touchListEvent({ touches: [first] }));
  timers.runNext();
  assert.deepEqual(terminal.selectedRanges.at(-1), [5, 1, 1]);
  gesture.handlePointerMove(touchEvent({ clientX: 190, clientY: 90 }));
  assert.deepEqual(terminal.selectedRanges.at(-1), [5, 1, 1]);
  gesture.handleTouchMove(touchListEvent({
    touches: [touchPoint({ clientX: 150, clientY: 80 })],
    preventDefault: () => { prevented += 1; }
  }));
  assert.equal(prevented, 1);
  assert.deepEqual(terminal.selectedRanges.at(-1), [5, 1, 71]);
  await gesture.handleTouchEnd(touchListEvent({
    changedTouches: [touchPoint({ clientX: 150, clientY: 80 })],
    preventDefault: () => { prevented += 1; }
  }));
  assert.deepEqual(copied, []);
  await gesture.retryCopy();
  assert.deepEqual(copied, ['range-5-1-71']);
  assert.equal(prevented, 2);
  gesture.dispose();
});

test('touch hold selects a complete wide glyph and a second touch cancels', () => {
  const timers = createFakeTimers();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  terminal.cellWidths.set('1:5', 2);
  terminal.cellWidths.set('1:6', 0);
  const gesture = createTerminalCopyGesture({
    surface: new FakeElement(),
    host: new FakeElement(),
    terminal,
    useTouchEvents: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    writeClipboard: async () => {}
  });
  const first = touchPoint({ clientX: 65 });

  gesture.handleTouchStart(touchListEvent({ touches: [first] }));
  timers.runNext();
  assert.deepEqual(terminal.selectedRanges.at(-1), [5, 1, 2]);
  gesture.handleTouchStart(touchListEvent({
    touches: [first, touchPoint({ identifier: 2, clientX: 90 })]
  }));
  assert.equal(gesture.phase, 'idle');
  assert.equal(terminal.getSelection(), '');
  gesture.dispose();
});

test('contextual Copy tries the Clipboard API then falls back to hidden selection copy', async () => {
  const timers = createFakeTimers();
  const terminal = new FakeTerminal({ cols: 20, rows: 5 });
  const status = new FakeElement();
  const statusText = new FakeElement();
  let clipboardCalls = 0;
  let execCommandCalls = 0;
  let appendedTextarea = null;
  let removed = false;
  const documentRef = {
    body: {
      appendChild(element) {
        appendedTextarea = element;
      }
    },
    createElement(tagName) {
      assert.equal(tagName, 'textarea');
      return {
        value: '',
        style: {},
        setAttribute() {},
        select() {},
        setSelectionRange() {},
        remove() { removed = true; }
      };
    },
    execCommand(command) {
      assert.equal(command, 'copy');
      execCommandCalls += 1;
      return true;
    }
  };
  const gesture = createTerminalCopyGesture({
    surface: new FakeElement(),
    host: new FakeElement(),
    terminal,
    status,
    statusText,
    useTouchEvents: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    clipboard: {
      async writeText() {
        clipboardCalls += 1;
        throw new Error('not allowed for this release gesture');
      }
    },
    documentRef
  });
  const first = touchPoint();

  gesture.handleTouchStart(touchListEvent({ touches: [first] }));
  timers.runNext();
  await gesture.handleTouchEnd(touchListEvent({ changedTouches: [first] }));
  assert.equal(execCommandCalls, 0);
  assert.equal(clipboardCalls, 0);
  assert.equal(statusText.textContent, 'Selected');

  await gesture.retryCopy();
  assert.equal(execCommandCalls, 1);
  assert.equal(clipboardCalls, 1);
  assert.equal(appendedTextarea.value, 'range-5-1-1');
  assert.equal(removed, true);
  assert.equal(statusText.textContent, 'Copied');
  gesture.dispose();
});

test('native touch scroll proxy maps outer momentum position into xterm history rows', () => {
  const root = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const host = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const spacer = new FakeElement();
  root.scrollHeight = 500;
  const view = createOperatorTerminalView({
    root,
    host,
    scrollSpacer: spacer,
    TerminalClass: FakeTerminal,
    useNativeScrollProxy: true,
    useTouchEvents: true
  });
  view.terminal.resize(20, 5);
  view.terminal.buffer.active.baseY = 20;
  view.setFontScale(1);

  assert.equal(spacer.style.height, '400px');
  root.dispatchEvent(new Event('touchstart'));
  root.scrollTop = 86;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(view.terminal.buffer.active.viewportY, 4);
  assert.equal(host.style.transform, 'translateY(-6px)');
  assert.equal(view.isNearBottom(), false);

  view.dispose();
  assert.equal(host.style.transform, '');
  assert.equal(spacer.style.height, '0px');
});

test('native touch scroll proxy restores incidental layout jumps but preserves deliberate history scrolling', () => {
  const root = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const host = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const spacer = new FakeElement();
  root.scrollHeight = 500;
  root.scrollTop = 400;
  const view = createOperatorTerminalView({
    root,
    host,
    scrollSpacer: spacer,
    TerminalClass: FakeTerminal,
    useNativeScrollProxy: true,
    useTouchEvents: true,
    ResizeObserverClass: null
  });
  view.terminal.resize(20, 5);
  view.terminal.buffer.active.baseY = 20;
  view.terminal.buffer.active.viewportY = 20;

  root.scrollTop = 0;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(root.scrollTop, root.scrollHeight);
  assert.equal(view.terminal.buffer.active.viewportY, 20);
  assert.equal(view.isNearBottom(), true);

  root.dispatchEvent(new Event('touchstart'));
  root.scrollTop = 0;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(root.scrollTop, 0);
  assert.equal(view.terminal.buffer.active.viewportY, 0);
  assert.equal(view.isNearBottom(), false);

  view.setFontScale(1.1);
  assert.equal(root.scrollTop, 0);
  assert.equal(view.terminal.buffer.active.viewportY, 0);

  view.dispose();
});

test('native touch scroll proxy reaches the final row when a wide frame has spare height', () => {
  const root = new FakeElement({ top: 0, bottom: 120, left: 0, width: 200, height: 120 });
  const host = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const spacer = new FakeElement();
  const view = createOperatorTerminalView({
    root,
    host,
    scrollSpacer: spacer,
    TerminalClass: FakeTerminal,
    useNativeScrollProxy: true,
    ResizeObserverClass: null
  });
  view.terminal.resize(20, 5);
  view.terminal.buffer.active.baseY = 20;
  view.setFontScale(1);

  assert.equal(spacer.style.height, '420px');

  root.scrollHeight = 519.5;
  root.scrollTop = 399.5;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(view.terminal.buffer.active.viewportY, 20);
  assert.equal(host.style.transform, '');

  view.dispose();
});

test('native touch scroll proxy keeps the final physical rows reachable in a compact frame', () => {
  const root = new FakeElement({ top: 0, bottom: 80, left: 0, width: 200, height: 80 });
  const host = new FakeElement({ top: 0, bottom: 100, left: 0, width: 200, height: 100 });
  const spacer = new FakeElement();
  const view = createOperatorTerminalView({
    root,
    host,
    scrollSpacer: spacer,
    TerminalClass: FakeTerminal,
    useNativeScrollProxy: true,
    ResizeObserverClass: null
  });
  view.terminal.resize(20, 5);
  view.terminal.buffer.active.baseY = 20;
  view.setFontScale(1);

  assert.equal(spacer.style.height, '400px');

  root.scrollHeight = 500;
  root.scrollTop = 420;
  root.dispatchEvent(new Event('scroll'));
  assert.equal(view.terminal.buffer.active.viewportY, 20);
  assert.equal(host.style.transform, 'translateY(-20px)');

  view.dispose();
});

test('terminal view subscribes only while visible, applies ordered writes, acks after parse, and requests one resync per gap', async () => {
  const sent = [];
  const view = createOperatorTerminalView({
    root: new FakeElement(),
    host: new FakeElement(),
    TerminalClass: FakeTerminal,
    sendPayload(payload) {
      sent.push(payload);
      return true;
    },
    sessionId: 's1'
  });
  assert.equal(view.terminal.options.fontSize, 14);

  view.socketOpen();
  assert.equal(sent.length, 0);
  view.setVisible(true);
  assert.equal(sent.at(-1).type, 'operator_terminal_subscribe');

  await view.handleReset({
    type: 'operator_terminal_reset',
    session_id: 's1',
    pane: '%3',
    generation: 7,
    seq: 10,
    cols: 30,
    rows: 6,
    data_base64: Buffer.from('seed').toString('base64')
  });
  assert.equal(view.terminal.resetCount, 1);
  assert.deepEqual(view.terminal.writes, ['seed']);
  assert.equal(sent.at(-1).type, 'operator_terminal_ack');
  assert.equal(sent.at(-1).seq, 10);

  await view.handleData({
    type: 'operator_terminal_data',
    session_id: 's1',
    pane: '%3',
    generation: 7,
    seq: 11,
    data_base64: Buffer.from('delta').toString('base64')
  });
  assert.deepEqual(view.terminal.writes, ['seed', 'delta']);
  assert.equal(sent.at(-1).seq, 11);

  view.handleData({
    type: 'operator_terminal_data',
    session_id: 's1',
    pane: '%3',
    generation: 7,
    seq: 13,
    data_base64: Buffer.from('gap').toString('base64')
  });
  view.handleData({
    type: 'operator_terminal_data',
    session_id: 's1',
    pane: '%3',
    generation: 7,
    seq: 14,
    data_base64: Buffer.from('later').toString('base64')
  });
  assert.equal(sent.filter((payload) => payload.type === 'operator_terminal_resync').length, 1);
  assert.deepEqual(view.terminal.writes, ['seed', 'delta']);

  view.setVisible(false);
  assert.equal(sent.at(-1).type, 'operator_terminal_unsubscribe');
  view.dispose();
});
