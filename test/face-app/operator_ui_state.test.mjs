import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialOperatorUiState, deriveOperatorUiFlags, reduceOperatorUiState } from '../../face-app/public/operator_ui_state.js';

test('operator ui flags keep Esc visible and Close visible only while awaiting', () => {
  let state = createInitialOperatorUiState();
  let flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showEsc, true);
  assert.equal(flags.showClose, false);
  assert.equal(flags.showHandle, false);

  state = reduceOperatorUiState(state, {
    type: 'prompt_received',
    requestId: 'r1',
    prompt: {
      request_id: 'r1',
      state: 'awaiting_input',
      input_kind: 'text'
    }
  });

  flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showEsc, true);
  assert.equal(flags.showClose, true);
  assert.equal(flags.showPanel, true);

  state = reduceOperatorUiState(state, { type: 'panel_close' });
  flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showHandle, true);
  assert.equal(flags.showPanel, false);
});

test('operator ui exposes Restart when bridge is offline or in recovery mode', () => {
  let state = createInitialOperatorUiState();
  state = reduceOperatorUiState(state, { type: 'socket_open' });

  let flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showRestart, false);

  state = reduceOperatorUiState(state, { type: 'socket_close' });
  flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showRestart, true);

  state = reduceOperatorUiState(state, { type: 'socket_open' });
  state = reduceOperatorUiState(state, {
    type: 'operator_state',
    bridgeOnline: true,
    recoveryMode: true,
    noResponse: false,
    awaiting: false,
    requestId: null
  });
  flags = deriveOperatorUiFlags(state);
  assert.equal(flags.showRestart, true);
});
