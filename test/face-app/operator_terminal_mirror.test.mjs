import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperatorBridgeRuntime } from '../../face-app/dist/operator_bridge.js';

test('terminal snapshots are published only when content changes', async () => {
  const payloads = [];
  const snapshots = [
    { pane: 'main:0.0', lines: ['a', 'b'], truncated: true },
    { pane: 'main:0.0', lines: ['a', 'b'], truncated: true },
    { pane: 'main:0.0', lines: ['a', 'b', 'c'], truncated: true }
  ];
  let snapshotIndex = 0;

  const runtime = createOperatorBridgeRuntime({
    sessionId: 'default',
    tmuxController: {
      pane: 'main:0.0',
      async sendKey() {},
      async sendText() {},
      async restart() {},
      async captureTail() {
        const current = snapshots[Math.min(snapshotIndex, snapshots.length - 1)];
        snapshotIndex += 1;
        return current;
      }
    },
    sendPayload(payload) {
      payloads.push(payload);
      return true;
    },
    now: (() => {
      let ts = 5_000;
      return () => {
        ts += 1;
        return ts;
      };
    })()
  });

  const first = await runtime.publishTerminalSnapshot('default');
  const second = await runtime.publishTerminalSnapshot('default');
  const third = await runtime.publishTerminalSnapshot('default');

  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(third, true);

  const snapshotPayloads = payloads.filter((entry) => entry.type === 'operator_terminal_snapshot');
  assert.equal(snapshotPayloads.length, 2);
  assert.deepEqual(snapshotPayloads[0].lines, ['a', 'b']);
  assert.deepEqual(snapshotPayloads[1].lines, ['a', 'b', 'c']);
});
