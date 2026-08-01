import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  createHeadlessTerminalState,
  createOperatorTerminalTransport,
  createTerminalOutputBatcher,
  createTmuxControlModeClient,
  createTmuxControlParser,
  decodeTmuxControlOutput
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
