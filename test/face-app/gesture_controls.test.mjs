import assert from 'node:assert/strict';
import test from 'node:test';
import { createDoubleTapTracker, shouldIgnoreToggleTarget } from '../../face-app/public/gesture_controls.js';

test('shouldIgnoreToggleTarget returns true for interactive descendants', () => {
  const target = {
    closest(selector) {
      assert.match(selector, /button/);
      return { nodeName: 'BUTTON' };
    }
  };

  assert.equal(shouldIgnoreToggleTarget(target), true);
});

test('shouldIgnoreToggleTarget returns false for non-interactive targets', () => {
  const target = {
    closest() {
      return null;
    }
  };

  assert.equal(shouldIgnoreToggleTarget(target), false);
  assert.equal(shouldIgnoreToggleTarget(null), false);
});

test('createDoubleTapTracker recognizes a valid double tap', () => {
  const trackTap = createDoubleTapTracker({ maxIntervalMs: 300, maxDistancePx: 20 });
  assert.equal(trackTap(1_000, 100, 100), false);
  assert.equal(trackTap(1_200, 108, 106), true);
});

test('createDoubleTapTracker rejects taps that are too slow or too far', () => {
  const trackTap = createDoubleTapTracker({ maxIntervalMs: 300, maxDistancePx: 20 });
  assert.equal(trackTap(1_000, 10, 10), false);
  assert.equal(trackTap(1_450, 11, 11), false);

  const trackTapDistance = createDoubleTapTracker({ maxIntervalMs: 300, maxDistancePx: 20 });
  assert.equal(trackTapDistance(2_000, 10, 10), false);
  assert.equal(trackTapDistance(2_200, 40, 45), false);
});
