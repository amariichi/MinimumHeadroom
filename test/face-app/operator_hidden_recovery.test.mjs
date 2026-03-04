import assert from 'node:assert/strict';
import test from 'node:test';
import { createTapBurstTrigger } from '../../face-app/public/operator_hidden_recovery.js';

test('tap burst trigger fires on the required tap count inside the window', () => {
  const trigger = createTapBurstTrigger({
    requiredCount: 4,
    windowMs: 1_600
  });

  assert.equal(trigger.recordTap(1_000), false);
  assert.equal(trigger.recordTap(1_200), false);
  assert.equal(trigger.recordTap(1_400), false);
  assert.equal(trigger.recordTap(1_550), true);
});

test('tap burst trigger resets after firing and expires old taps', () => {
  const trigger = createTapBurstTrigger({
    requiredCount: 3,
    windowMs: 400
  });

  assert.equal(trigger.recordTap(1_000), false);
  assert.equal(trigger.recordTap(1_250), false);
  assert.equal(trigger.recordTap(1_350), true);

  assert.equal(trigger.recordTap(2_000), false);
  assert.equal(trigger.recordTap(2_450), false);
  assert.equal(trigger.recordTap(2_900), false);
});
