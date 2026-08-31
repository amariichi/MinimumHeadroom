import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createHeadlessTerminalState,
  createOperatorTerminalTransport,
  createTerminalOutputBatcher,
  createTmuxControlModeClient,
  createTmuxControlParser,
  cursorRestoreSequence,
  decodeTmuxControlOutput,
  parseCursorReply
} from '../../face-app/dist/operator_terminal_stream.js';

const execFileAsync = promisify(execFile);
const silentLog = { info() {}, warn() {}, error() {} };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('tmux output decoding replaces only three-digit octal escapes', () => {
  const encoded = Buffer.from('plain\\134slash\\033[31m 日本語 \\12 not-three \\999');
  const decoded = decodeTmuxControlOutput(encoded);
  assert.deepEqual(
    decoded,
    Buffer.concat([
      Buffer.from('plain\\slash'),
      Buffer.from([0x1b]),
      Buffer.from('[31m 日本語 \\12 not-three \\999')
    ])
  );
});

test('control parser preserves bytes across arbitrary chunks and filters response framing', () => {
  const outputs = [];
  const responses = [];
  const notifications = [];
  const parser = createTmuxControlParser({
    onOutput: (value) => outputs.push(value),
    onResponse: (value) => responses.push(value),
    onNotification: (value) => notifications.push(value.line)
  });
  const source = Buffer.from(
    '%session-changed $0 demo\n'
      + '%begin 100 4 1\n'
      + '\u001b[31mred\u001b[0m\n'
      + '日本語\n'
      + '%end 100 4 1\n'
      + '%output %7 A\\015\\012日本語\\134tail\n'
      + '%output %8 ignored\n'
  );

  for (let index = 0; index < source.length; index += 3) {
    parser.push(source.subarray(index, index + 3));
  }
  parser.end();

  assert.deepEqual(notifications, ['%session-changed $0 demo']);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[0].data.toString('utf8'), '\u001b[31mred\u001b[0m\r\n日本語');
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].pane, '%7');
  assert.deepEqual(outputs[0].data, Buffer.from('A\r\n日本語\\tail'));
  assert.equal(outputs[1].pane, '%8');
});

test('terminal batcher flushes on byte cap and timer without losing order', () => {
  const timers = [];
  const batches = [];
  const batcher = createTerminalOutputBatcher({
    maxDelayMs: 20,
    maxBytes: 4,
    onBatch: (value) => batches.push(value.toString('utf8')),
    setTimer(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimer() {}
  });

  batcher.push('abcdef');
  assert.deepEqual(batches, ['abcd']);
  assert.equal(batcher.pendingBytes, 2);
  timers[timers.length - 1]();
  assert.deepEqual(batches, ['abcd', 'ef']);
});

test('headless terminal serializes a replayable colored UTF-8 checkpoint', async () => {
  const state = createHeadlessTerminalState({ cols: 20, rows: 3, scrollback: 50 });
  await state.resetFromCapture(Buffer.from('one\r\ntwo'));
  await state.write(Buffer.from('\r\n\u001b[31m赤\u001b[0m'));
  const serialized = await state.serialize();
  assert.match(serialized, /one\r\ntwo/u);
  assert.match(serialized, /\u001b\[31m赤/u);
  await state.dispose();
});

test('Control Mode client captures and then emits exact live pane bytes on a private tmux socket', async (t) => {
  const socketName = `mh-terminal-test-${process.pid}-${Date.now()}`;
  const sessionName = 'mh-terminal-probe';
  let client = null;

  t.after(async () => {
    try {
      await client?.stop();
    } catch {}
    try {
      await execFileAsync('tmux', ['-L', socketName, 'kill-server']);
    } catch {}
  });

  await execFileAsync('tmux', [
    '-L', socketName,
    '-f', '/dev/null',
    'new-session', '-d', '-s', sessionName, '-x', '50', '-y', '6'
  ]);
  await execFileAsync('tmux', [
    '-L', socketName,
    'send-keys', '-t', `${sessionName}:0.0`, '-l', "printf 'seed\\n'"
  ]);
  await execFileAsync('tmux', ['-L', socketName, 'send-keys', '-t', `${sessionName}:0.0`, 'Enter']);

  const live = [];
  client = createTmuxControlModeClient({
    pane: `${sessionName}:0.0`,
    tmuxArgs: ['-L', socketName],
    onOutput: (data) => live.push(data),
    log: silentLog
  });
  const info = await client.start();
  assert.match(info.pane, /^%\d+$/u);
  const capture = await client.capturePane(20);
  assert.match(capture.toString('utf8'), /seed/u);

  await execFileAsync('tmux', [
    '-L', socketName,
    'send-keys', '-t', `${sessionName}:0.0`, '-l', "printf '\\033[31mlive\\033[0m 日本語\\n'"
  ]);
  await execFileAsync('tmux', ['-L', socketName, 'send-keys', '-t', `${sessionName}:0.0`, 'Enter']);

  const expectedLive = Buffer.from('\u001b[31mlive\u001b[0m 日本語');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !Buffer.concat(live).includes(expectedLive)) {
    await delay(10);
  }
  const received = Buffer.concat(live);
  assert.equal(
    received.includes(expectedLive),
    true,
    `received=${JSON.stringify(received.toString('utf8'))}`
  );
});

test('cursor replies parse into a one-based absolute position sequence', () => {
  assert.deepEqual(parseCursorReply(Buffer.from('2,27')), { x: 2, y: 27 });
  assert.deepEqual(parseCursorReply(' 0,0 \n'), { x: 0, y: 0 });
  assert.equal(parseCursorReply('no such pane'), null);
  assert.equal(parseCursorReply(''), null);
  assert.equal(cursorRestoreSequence({ x: 2, y: 27 }), '[28;3H');
  assert.equal(cursorRestoreSequence(null), null);
});

test('Control Mode capture restores the real pane cursor instead of the last captured row', async (t) => {
  const socketName = `mh-cursor-test-${process.pid}-${Date.now()}`;
  const sessionName = 'mh-cursor-probe';
  let client = null;

  t.after(async () => {
    try {
      await client?.stop();
    } catch {}
    try {
      await execFileAsync('tmux', ['-L', socketName, 'kill-server']);
    } catch {}
  });

  // A 6-row pane holding only two lines: exactly the shape of a freshly
  // started helper pane, where the cursor sits far above the last screen row.
  await execFileAsync('tmux', [
    '-L', socketName,
    '-f', '/dev/null',
    'new-session', '-d', '-s', sessionName, '-x', '40', '-y', '6', 'sh'
  ]);
  await execFileAsync('tmux', [
    '-L', socketName,
    'send-keys', '-t', `${sessionName}:0.0`, '-l', "printf 'top\\n'"
  ]);
  await execFileAsync('tmux', ['-L', socketName, 'send-keys', '-t', `${sessionName}:0.0`, 'Enter']);
  await delay(400);

  const cursorProbe = await execFileAsync('tmux', [
    '-L', socketName,
    'display-message', '-p', '-t', `${sessionName}:0.0`, '#{cursor_y}'
  ]);
  const paneCursorRow = Number.parseInt(cursorProbe.stdout.trim(), 10);
  assert.ok(paneCursorRow < 5, `expected the pane cursor above the last row, got ${paneCursorRow}`);

  client = createTmuxControlModeClient({
    pane: `${sessionName}:0.0`,
    tmuxArgs: ['-L', socketName],
    log: silentLog
  });
  await client.start();

  let seeded = null;
  const { cursor } = await client.capturePaneWithCursor(20, (capture, paneCursor) => {
    seeded = { capture, paneCursor };
  });
  assert.ok(seeded, 'the capture callback must run');
  assert.deepEqual(cursor, seeded.paneCursor);
  assert.equal(cursor.y, paneCursorRow);

  // Replaying the capture alone parks the cursor on the last captured row;
  // appending the restore sequence puts it back where tmux holds it, so the
  // next byte of live output lands on the right row.
  const state = createHeadlessTerminalState({ cols: 40, rows: 6, scrollback: 20 });
  await state.resetFromCapture(
    Buffer.concat([Buffer.from(seeded.capture), Buffer.from(cursorRestoreSequence(cursor), 'utf8')])
  );
  await state.write(Buffer.from('LIVE'));
  const checkpoint = await state.serialize();
  await state.dispose();

  const rows = checkpoint.split('\r\n');
  assert.equal(
    rows.findIndex((row) => row.includes('LIVE')),
    paneCursorRow,
    `live output must land on row ${paneCursorRow}: ${JSON.stringify(rows)}`
  );

  // Same seed without the restore: this is the old behaviour, and it puts live
  // output on the last captured row, 4 rows below where the pane really is.
  const drifting = createHeadlessTerminalState({ cols: 40, rows: 6, scrollback: 20 });
  await drifting.resetFromCapture(Buffer.from(seeded.capture));
  await drifting.write(Buffer.from('LIVE'));
  const driftedRows = (await drifting.serialize()).split('\r\n');
  await drifting.dispose();
  assert.equal(driftedRows.findIndex((row) => row.includes('LIVE')), 5);
});

test('Control Mode cursor capture settles every failed command after the client exits', async () => {
  let child = null;
  const client = createTmuxControlModeClient({
    pane: 'demo:0.0',
    runCommand: async () => ({ stdout: '%9\tdemo\t40\t8\n' }),
    spawnProcess() {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.kill = () => {
        child.killed = true;
      };
      queueMicrotask(() => child.stdout.write('%session-changed $0 demo\n'));
      return child;
    },
    log: silentLog
  });

  await client.start();
  child.emit('close', 0, null);

  await assert.rejects(
    client.capturePaneWithCursor(20),
    (error) => error?.reason === 'tmux_control_offline'
  );
  // Give Node a turn to surface any sibling command rejection that the method
  // failed to observe. Under --unhandled-rejections=strict that would stop the
  // Operator stack, which is the live failure this test guards against.
  await delay(10);
});

test('terminal transport starts on subscribe, sequences deltas, targets reset, and stops at zero subscribers', async () => {
  const payloads = [];
  const clients = [];
  const tmux = { pane: 'demo:0.0' };

  function createFakeClient(options) {
    const fake = {
      stopped: false,
      async start() {
        return { pane: '%9', session: 'demo', cols: 40, rows: 8 };
      },
      async capturePane(_scrollback, onComplete) {
        const capture = Buffer.from('seed');
        onComplete(capture);
        return capture;
      },
      emit(data) {
        options.onOutput(Buffer.from(data));
      },
      async stop() {
        this.stopped = true;
      }
    };
    clients.push(fake);
    return fake;
  }

  function createFakeState() {
    let content = '';
    return {
      async resetFromCapture(data) {
        content = Buffer.from(data).toString('utf8');
      },
      async write(data) {
        content += Buffer.from(data).toString('utf8');
      },
      async serialize() {
        return content;
      },
      async dispose() {}
    };
  }

  const transport = createOperatorTerminalTransport({
    sessionId: 's1',
    tmuxController: tmux,
    createClient: createFakeClient,
    createState: createFakeState,
    batchDelayMs: 2,
    batchMaxBytes: 1024,
    sendPayload(payload) {
      payloads.push(payload);
      return true;
    },
    now: () => 123
  });

  await transport.handleSubscribe({ subscriber_id: 'browser-1' });
  const reset = payloads.find((payload) => payload.type === 'operator_terminal_reset');
  assert.ok(reset);
  assert.equal(reset.subscriber_id, 'browser-1');
  assert.equal(Buffer.from(reset.data_base64, 'base64').toString('utf8'), 'seed');

  clients[0].emit('delta');
  await delay(10);
  const data = payloads.find((payload) => payload.type === 'operator_terminal_data');
  assert.ok(data);
  assert.equal(data.generation, reset.generation);
  assert.equal(data.seq, reset.seq + 1);
  assert.equal(Buffer.from(data.data_base64, 'base64').toString('utf8'), 'delta');

  await transport.handleAck({
    subscriber_id: 'browser-1',
    generation: data.generation,
    seq: data.seq,
    needs_reset: true
  });
  assert.equal(payloads.filter((payload) => payload.type === 'operator_terminal_reset').length, 2);

  await transport.handleUnsubscribe({ subscriber_id: 'browser-1' });
  assert.equal(clients[0].stopped, true);
  assert.equal(transport.getState().subscriberCount, 0);
  await transport.shutdown();
});

test('terminal transport serializes bridge takeover subscriptions with an in-flight start', async () => {
  const clients = [];
  let releaseFirstStart = null;

  const transport = createOperatorTerminalTransport({
    sessionId: 's1',
    tmuxController: { pane: 'demo:0.0' },
    createClient: () => {
      const index = clients.length;
      const fake = {
        stopped: false,
        async start() {
          if (index === 0) {
            await new Promise((resolve) => {
              releaseFirstStart = resolve;
            });
          }
          return { pane: '%9', session: 'demo', cols: 40, rows: 8 };
        },
        async capturePane(_scrollback, onComplete) {
          const capture = Buffer.from(`seed-${index}`);
          onComplete(capture);
          return capture;
        },
        async stop() {
          this.stopped = true;
        }
      };
      clients.push(fake);
      return fake;
    },
    createState: () => ({
      async resetFromCapture() {},
      async write() {},
      async serialize() { return ''; },
      async dispose() {}
    }),
    sendPayload() { return true; },
    log: silentLog
  });

  const firstSubscribe = transport.handleSubscribe({ subscriber_id: 'browser-1' });
  while (!releaseFirstStart) {
    await delay(1);
  }
  const unsubscribe = transport.handleUnsubscribe({ subscriber_id: 'browser-1' });
  const secondSubscribe = transport.handleSubscribe({ subscriber_id: 'browser-1' });
  await delay(10);
  const clientsStartedBeforeFirstCompleted = clients.length;
  releaseFirstStart();

  const results = await Promise.allSettled([firstSubscribe, unsubscribe, secondSubscribe]);
  assert.equal(
    clientsStartedBeforeFirstCompleted,
    1,
    'unsubscribe/resubscribe must wait until the original Control Mode start completes'
  );
  assert.equal(results.every((result) => result.status === 'fulfilled'), true);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].stopped, true);
  await transport.shutdown();
});

test('a burst of stale acknowledgements collapses into a single reset', async () => {
  const payloads = [];

  const transport = createOperatorTerminalTransport({
    sessionId: 's1',
    tmuxController: { pane: 'demo:0.0' },
    createClient: (options) => ({
      async start() {
        return { pane: '%9', session: 'demo', cols: 40, rows: 8 };
      },
      async capturePaneWithCursor(_scrollback, onComplete) {
        const capture = Buffer.from('seed');
        onComplete(capture, { x: 0, y: 0 });
        return { capture, cursor: { x: 0, y: 0 } };
      },
      emit(data) {
        options.onOutput(Buffer.from(data));
      },
      async stop() {}
    }),
    createState: () => {
      let content = '';
      return {
        async resetFromCapture(data) {
          content = Buffer.from(data).toString('utf8');
        },
        async write(data) {
          content += Buffer.from(data).toString('utf8');
        },
        async serialize() {
          return content;
        },
        async dispose() {}
      };
    },
    batchDelayMs: 2,
    batchMaxBytes: 1024,
    sendPayload(payload) {
      payloads.push(payload);
      return true;
    },
    now: () => 123
  });

  await transport.handleSubscribe({ subscriber_id: 'browser-1' });
  const resetsAfterSubscribe = payloads.filter((payload) => payload.type === 'operator_terminal_reset').length;

  // A browser that stalled and caught up acknowledges a batch of frames at
  // once, every one of them carrying a generation the bridge has moved past.
  // Each of those used to queue its own full-screen refresh.
  const staleAcks = Array.from({ length: 10 }, () => transport.handleAck({
    subscriber_id: 'browser-1',
    generation: 999,
    seq: 1
  }));
  await Promise.all(staleAcks);
  await delay(10);

  const resets = payloads.filter((payload) => payload.type === 'operator_terminal_reset').length;
  assert.equal(resets - resetsAfterSubscribe, 1, `expected one coalesced reset, got ${resets - resetsAfterSubscribe}`);

  // A later desync still gets served: coalescing only suppresses duplicates of
  // a refresh that has not been sent yet.
  await transport.handleResync({ subscriber_id: 'browser-1' });
  await delay(10);
  assert.equal(
    payloads.filter((payload) => payload.type === 'operator_terminal_reset').length - resetsAfterSubscribe,
    2
  );

  await transport.shutdown();
});
