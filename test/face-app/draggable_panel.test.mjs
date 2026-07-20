import assert from 'node:assert/strict';
import test from 'node:test';
import { constrainPanelRect, createDraggablePanel } from '../../face-app/public/draggable_panel.js';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    this.listeners.set(name, listeners.filter((candidate) => candidate !== listener));
  }

  emit(name, values = {}) {
    const event = {
      type: name,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      ...values
    };
    for (const listener of this.listeners.get(name) ?? []) {
      listener(event);
    }
    return event;
  }
}

function createClassList() {
  const classes = new Set();
  return {
    add(name) {
      classes.add(name);
    },
    remove(name) {
      classes.delete(name);
    },
    contains(name) {
      return classes.has(name);
    }
  };
}

function createPanel(rect) {
  const target = new FakeEventTarget();
  const properties = new Map();
  target.style = {
    willChange: '',
    setProperty(name, value) {
      properties.set(name, value);
    }
  };
  target.classList = createClassList();
  target.setPointerCapture = () => {};
  target.releasePointerCapture = () => {};
  target.getBoundingClientRect = () => {
    const x = Number.parseFloat(properties.get('--draggable-panel-x') ?? '0');
    const y = Number.parseFloat(properties.get('--draggable-panel-y') ?? '0');
    return {
      left: rect.left + x,
      top: rect.top + y,
      right: rect.left + x + rect.width,
      bottom: rect.top + y + rect.height,
      width: rect.width,
      height: rect.height
    };
  };
  return target;
}

test('constrainPanelRect keeps a panel inside its padded bounds', () => {
  assert.deepEqual(
    constrainPanelRect(
      { left: 350, top: -20, width: 100, height: 80 },
      { left: 0, top: 0, width: 400, height: 300 },
      8
    ),
    { left: 292, top: 8, deltaX: -58, deltaY: 28 }
  );
});

test('createDraggablePanel moves touch pointers and clamps the result', () => {
  const panel = createPanel({ left: 14, top: 180, width: 100, height: 80 });
  const bounds = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };
    }
  };
  const windowTarget = new FakeEventTarget();
  const controller = createDraggablePanel({
    element: panel,
    handle: panel,
    bounds,
    windowTarget,
    edgePadding: 8
  });

  const down = panel.emit('pointerdown', {
    pointerId: 7,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    clientX: 20,
    clientY: 190
  });
  assert.equal(down.defaultPrevented, true);
  assert.equal(panel.classList.contains('is-dragging'), true);
  assert.equal(panel.style.willChange, 'transform');

  panel.emit('pointermove', {
    pointerId: 7,
    clientX: 500,
    clientY: -100
  });
  assert.deepEqual(controller.snapshot(), { x: 278, y: -172, dragging: true });
  assert.deepEqual(panel.getBoundingClientRect(), {
    left: 292,
    top: 8,
    right: 392,
    bottom: 88,
    width: 100,
    height: 80
  });

  panel.emit('pointerup', { pointerId: 7 });
  assert.equal(controller.snapshot().dragging, false);
  assert.equal(panel.classList.contains('is-dragging'), false);
  assert.equal(panel.style.willChange, '');
  controller.destroy();
});

test('createDraggablePanel ignores non-primary mouse buttons', () => {
  const panel = createPanel({ left: 14, top: 14, width: 100, height: 80 });
  const bounds = {
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 };
    }
  };
  const controller = createDraggablePanel({
    element: panel,
    handle: panel,
    bounds,
    windowTarget: new FakeEventTarget()
  });

  panel.emit('pointerdown', {
    pointerId: 9,
    pointerType: 'mouse',
    isPrimary: true,
    button: 2,
    clientX: 20,
    clientY: 20
  });
  panel.emit('pointermove', { pointerId: 9, clientX: 200, clientY: 200 });
  assert.deepEqual(controller.snapshot(), { x: 0, y: 0, dragging: false });
  controller.destroy();
});
