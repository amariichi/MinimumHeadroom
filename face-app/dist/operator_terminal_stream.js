import { spawn as nodeSpawn } from 'node:child_process';
import headlessPackage from '@xterm/headless';
import serializePackage from '@xterm/addon-serialize';

const { Terminal: HeadlessTerminal } = headlessPackage;
const { SerializeAddon } = serializePackage;

const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;
const BACKSLASH = 0x5c;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.min(maximum, parsed));
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function toLogger(log) {
  if (!log) {
    return { info() {}, warn() {}, error() {} };
  }
  return {
    info: typeof log.info === 'function' ? log.info.bind(log) : () => {},
    warn: typeof log.warn === 'function' ? log.warn.bind(log) : () => {},
    error: typeof log.error === 'function' ? log.error.bind(log) : () => {}
  };
}

function terminalError(reason, message, cause = null) {
  const error = new Error(message);
  error.reason = reason;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function runProcess(command, args, options = {}) {
  const timeoutMs = clampInteger(options.timeoutMs, 8000, 200, 120_000);
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGKILL');
      reject(terminalError('tmux_timeout', `command timed out: ${command} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(terminalError('tmux_spawn_failed', `failed to start ${command}: ${error.message}`, error));
    });
    child.once('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (code === 0) {
        resolve({ stdout: stdoutBuffer.toString('utf8'), stdoutBuffer, stderr: stderrText, code });
        return;
      }
      reject(
        terminalError(
          'tmux_exit_nonzero',
          `command failed (${code}): ${command} ${args.join(' ')}${stderrText ? ` (${stderrText})` : ''}`
        )
      );
    });
  });
}

function isOctalDigit(byte) {
  return byte >= OCTAL_ZERO && byte <= OCTAL_SEVEN;
}

export function decodeTmuxControlOutput(value) {
  const source = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
  const decoded = Buffer.allocUnsafe(source.length);
  let outputIndex = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (
      source[index] === BACKSLASH
      && index + 3 < source.length
      && isOctalDigit(source[index + 1])
      && isOctalDigit(source[index + 2])
      && isOctalDigit(source[index + 3])
    ) {
      decoded[outputIndex] =
        ((source[index + 1] - OCTAL_ZERO) << 6)
        | ((source[index + 2] - OCTAL_ZERO) << 3)
        | (source[index + 3] - OCTAL_ZERO);
      outputIndex += 1;
      index += 3;
      continue;
    }
    decoded[outputIndex] = source[index];
    outputIndex += 1;
  }

  return decoded.subarray(0, outputIndex);
}

function stripProtocolCarriageReturn(line) {
  return line.length > 0 && line[line.length - 1] === CARRIAGE_RETURN
    ? line.subarray(0, line.length - 1)
    : line;
}

function parseOutputNotification(line, extended = false) {
  const prefix = extended ? Buffer.from('%extended-output ') : Buffer.from('%output ');
  if (line.length <= prefix.length || !line.subarray(0, prefix.length).equals(prefix)) {
    return null;
  }

  const firstSpace = line.indexOf(0x20, prefix.length);
  if (firstSpace < 0) {
    return null;
  }
  const pane = line.subarray(prefix.length, firstSpace).toString('utf8');
  let dataStart = firstSpace + 1;
  let age = null;
  if (extended) {
    const secondSpace = line.indexOf(0x20, dataStart);
    if (secondSpace < 0) {
      return null;
    }
    age = Number.parseInt(line.subarray(dataStart, secondSpace).toString('ascii'), 10);
    dataStart = secondSpace + 1;
  }
  return {
    pane,
    age: Number.isFinite(age) ? age : null,
    data: decodeTmuxControlOutput(line.subarray(dataStart))
  };
}

export function parseCursorReply(value) {
  const text = (Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '')).trim();
  const match = /^(\d+),(\d+)$/u.exec(text);
  if (!match) {
    return null;
  }
  const x = Number.parseInt(match[1], 10);
  const y = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    return null;
  }
  return { x, y };
}

// CUP ("cursor position") places the cursor at an absolute row and column of
// the screen; both are 1-based in the escape sequence and 0-based in tmux.
export function cursorRestoreSequence(cursor) {
  if (!cursor || !Number.isSafeInteger(cursor.x) || !Number.isSafeInteger(cursor.y)) {
    return null;
  }
  return `\u001b[${Math.max(0, cursor.y) + 1};${Math.max(0, cursor.x) + 1}H`;
}

function parseBoundary(line, prefix) {
  const text = line.toString('utf8');
  if (!text.startsWith(prefix)) {
    return null;
  }
  const parts = text.split(/\s+/u);
  if (parts.length < 4) {
    return null;
  }
  return {
    timestamp: parts[1],
    commandNumber: parts[2],
    flags: parts[3],
    key: `${parts[1]}:${parts[2]}:${parts[3]}`
  };
}

export function createTmuxControlParser(options = {}) {
  const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
  const onNotification = typeof options.onNotification === 'function' ? options.onNotification : () => {};
  const onResponse = typeof options.onResponse === 'function' ? options.onResponse : () => {};
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const maxLineBytes = clampInteger(options.maxLineBytes, 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
  let buffered = Buffer.alloc(0);
  let response = null;
  let ended = false;

  function consumeLine(rawLine) {
    const line = stripProtocolCarriageReturn(rawLine);
    if (response) {
      const end = parseBoundary(line, '%end ');
      const failure = parseBoundary(line, '%error ');
      if ((end && end.key === response.key) || (failure && failure.key === response.key)) {
        onResponse({
          ...response,
          ok: Boolean(end),
          lines: response.lines,
          data: Buffer.concat(
            response.lines.flatMap((item, index) => index === 0 ? [item] : [Buffer.from('\r\n'), item])
          )
        });
        response = null;
        return;
      }
      response.lines.push(Buffer.from(line));
      return;
    }

    const begin = parseBoundary(line, '%begin ');
    if (begin) {
      response = { ...begin, lines: [] };
      return;
    }

    const output = parseOutputNotification(line, false) ?? parseOutputNotification(line, true);
    if (output) {
      onOutput(output);
      return;
    }

    onNotification({ line: line.toString('utf8'), raw: Buffer.from(line) });
  }

  return {
    push(chunk) {
      if (ended) {
        throw new Error('tmux control parser has ended');
      }
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '');
      if (incoming.length === 0) {
        return;
      }
      buffered = buffered.length === 0 ? Buffer.from(incoming) : Buffer.concat([buffered, incoming]);
      if (buffered.length > maxLineBytes && buffered.indexOf(LINE_FEED) < 0) {
        const error = terminalError('tmux_control_line_too_large', `control line exceeded ${maxLineBytes} bytes`);
        buffered = Buffer.alloc(0);
        onError(error);
        return;
      }
      let newlineIndex;
      while ((newlineIndex = buffered.indexOf(LINE_FEED)) >= 0) {
        const line = buffered.subarray(0, newlineIndex);
        buffered = buffered.subarray(newlineIndex + 1);
        consumeLine(line);
      }
    },
    end() {
      if (ended) {
        return;
      }
      ended = true;
      if (buffered.length > 0) {
        consumeLine(buffered);
        buffered = Buffer.alloc(0);
      }
      if (response) {
        onError(terminalError('tmux_control_response_incomplete', 'control stream ended inside a command response'));
        response = null;
      }
    }
  };
}

export function createTerminalOutputBatcher(options = {}) {
  const maxDelayMs = clampInteger(options.maxDelayMs, 24, 1, 1000);
  const maxBytes = clampInteger(options.maxBytes, 16 * 1024, 1, 1024 * 1024);
  const onBatch = typeof options.onBatch === 'function' ? options.onBatch : () => {};
  const setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout;
  const clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout;
  let chunks = [];
  let byteLength = 0;
  let timer = null;
  let closed = false;

  function clearPendingTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function flush() {
    if (byteLength === 0) {
      clearPendingTimer();
      return null;
    }
    clearPendingTimer();
    const batch = Buffer.concat(chunks, byteLength);
    chunks = [];
    byteLength = 0;
    onBatch(batch);
    return batch;
  }

  function schedule() {
    if (timer !== null || byteLength === 0 || closed) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      flush();
    }, maxDelayMs);
  }

  return {
    push(value) {
      if (closed) {
        return;
      }
      let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value ?? '');
      while (chunk.length > 0) {
        const available = maxBytes - byteLength;
        const part = chunk.subarray(0, available);
        chunks.push(Buffer.from(part));
        byteLength += part.length;
        chunk = chunk.subarray(part.length);
        if (byteLength >= maxBytes) {
          flush();
        }
      }
      schedule();
    },
    flush,
    discard() {
      clearPendingTimer();
      chunks = [];
      byteLength = 0;
    },
    close() {
      if (closed) {
        return;
      }
      flush();
      closed = true;
      clearPendingTimer();
    },
    get pendingBytes() {
      return byteLength;
    }
  };
}

export function createHeadlessTerminalState(options = {}) {
  const cols = clampInteger(options.cols, 80, 2, 1000);
  const rows = clampInteger(options.rows, 24, 1, 1000);
  const scrollback = clampInteger(options.scrollback, 5000, 0, 100_000);
  const TerminalClass = options.TerminalClass ?? HeadlessTerminal;
  const SerializeAddonClass = options.SerializeAddonClass ?? SerializeAddon;
  const terminal = new TerminalClass({
    cols,
    rows,
    scrollback,
    allowProposedApi: true
  });
  const serializeAddon = new SerializeAddonClass();
  terminal.loadAddon(serializeAddon);
  let writeQueue = Promise.resolve();
  let disposed = false;

  function enqueueWrite(value, resetFirst = false) {
    const bytes = Buffer.isBuffer(value) ? new Uint8Array(value) : value;
    writeQueue = writeQueue.then(() => new Promise((resolve, reject) => {
      if (disposed) {
        reject(terminalError('terminal_state_disposed', 'headless terminal state is disposed'));
        return;
      }
      try {
        if (resetFirst) {
          terminal.reset();
        }
        terminal.write(bytes, resolve);
      } catch (error) {
        reject(error);
      }
    }));
    return writeQueue;
  }

  return {
    write(value) {
      return enqueueWrite(value, false);
    },
    resetFromCapture(value) {
      return enqueueWrite(value, true);
    },
    serialize() {
      const barrier = writeQueue;
      return barrier.then(() => serializeAddon.serialize({ scrollback }));
    },
    resize(nextCols, nextRows) {
      terminal.resize(
        clampInteger(nextCols, terminal.cols, 2, 1000),
        clampInteger(nextRows, terminal.rows, 1, 1000)
      );
    },
    async dispose() {
      disposed = true;
      try {
        await writeQueue;
      } catch {}
      serializeAddon.dispose();
      terminal.dispose();
    },
    get cols() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    }
  };
}

export function createTmuxControlModeClient(options = {}) {
  const requestedPane = asNonEmptyString(options.pane);
  if (!requestedPane) {
    throw new Error('tmux pane is required');
  }
  const tmuxArgs = Array.isArray(options.tmuxArgs) ? options.tmuxArgs.map(String) : [];
  const timeoutMs = clampInteger(options.timeoutMs, 8000, 200, 120_000);
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : runProcess;
  const spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : nodeSpawn;
  const onOutput = typeof options.onOutput === 'function' ? options.onOutput : () => {};
  const onExit = typeof options.onExit === 'function' ? options.onExit : () => {};
  const log = toLogger(options.log ?? console);
  let process = null;
  let parser = null;
  let paneInfo = null;
  let started = false;
  let stopping = false;
  let readyPromise = null;
  let resolveReady = null;
  let rejectReady = null;
  const commandQueue = [];

  function settleNextCommand(response) {
    const pending = commandQueue.shift();
    if (!pending) {
      return;
    }
    if (!response.ok) {
      pending.reject(terminalError('tmux_control_command_failed', `control command failed: ${pending.command}`));
      return;
    }
    try {
      pending.onComplete?.(response.data, response);
      pending.resolve(response);
    } catch (error) {
      pending.reject(error);
    }
  }

  function requestCommand(command, onComplete = null) {
    return requestCommandBatch([{ command, onComplete }])[0];
  }

  // tmux answers every command with its own %begin/%end block, even when the
  // commands arrive on one line separated by ';'. Writing the whole batch in a
  // single stdin write still matters: the tmux server reads and runs the batch
  // before it pumps pane output again, so no %output can be interleaved
  // between the commands. That is what makes a capture and a cursor query
  // describe the same instant.
  function requestCommandBatch(entries) {
    if (!process || process.killed || process.stdin.destroyed) {
      const offline = terminalError('tmux_control_offline', 'tmux Control Mode client is not running');
      return entries.map(() => Promise.reject(offline));
    }
    const pending = [];
    const promises = entries.map((entry) => new Promise((resolve, reject) => {
      pending.push({ command: entry.command, onComplete: entry.onComplete ?? null, resolve, reject });
    }));
    commandQueue.push(...pending);
    try {
      process.stdin.write(`${entries.map((entry) => entry.command).join('\n')}\n`);
    } catch (error) {
      const failure = terminalError('tmux_control_write_failed', error.message, error);
      for (const entry of pending) {
        const index = commandQueue.indexOf(entry);
        if (index >= 0) {
          commandQueue.splice(index, 1);
        }
        entry.reject(failure);
      }
    }
    return promises;
  }

  async function start() {
    if (started) {
      return paneInfo;
    }
    started = true;
    const result = await runCommand(
      'tmux',
      [...tmuxArgs, 'display-message', '-p', '-t', requestedPane, '#{pane_id}\t#{session_name}\t#{pane_width}\t#{pane_height}'],
      { timeoutMs }
    );
    const [pane, session, rawCols, rawRows] = String(result.stdout ?? '').trim().split('\t');
    if (!/^%\d+$/u.test(pane) || !session) {
      throw terminalError('tmux_pane_metadata_invalid', `invalid tmux pane metadata for ${requestedPane}`);
    }
    paneInfo = {
      pane,
      session,
      cols: clampInteger(rawCols, 80, 2, 1000),
      rows: clampInteger(rawRows, 24, 1, 1000)
    };

    readyPromise = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    parser = createTmuxControlParser({
      onOutput(output) {
        if (output.pane === paneInfo.pane) {
          onOutput(output.data, output);
        }
      },
      onNotification(notification) {
        if (notification.line.startsWith('%session-changed ')) {
          resolveReady?.(paneInfo);
          resolveReady = null;
          rejectReady = null;
        }
      },
      onResponse: settleNextCommand,
      onError(error) {
        log.warn(`[operator-terminal] Control Mode parse failed: ${error.message}`);
      }
    });

    process = spawnProcess('tmux', [...tmuxArgs, '-C', 'attach-session', '-t', paneInfo.session], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    process.stdout.on('data', (chunk) => parser.push(chunk));
    process.stderr.on('data', (chunk) => {
      const message = Buffer.from(chunk).toString('utf8').trim();
      if (message) {
        log.warn(`[operator-terminal] tmux Control Mode stderr: ${message}`);
      }
    });
    process.once('error', (error) => {
      rejectReady?.(terminalError('tmux_control_spawn_failed', error.message, error));
      rejectReady = null;
      resolveReady = null;
    });
    process.once('close', (code, signal) => {
      parser?.end();
      const error = terminalError(
        'tmux_control_exited',
        `tmux Control Mode exited (${code ?? signal ?? 'unknown'})`
      );
      rejectReady?.(error);
      rejectReady = null;
      resolveReady = null;
      while (commandQueue.length > 0) {
        commandQueue.shift().reject(error);
      }
      process = null;
      if (!stopping) {
        onExit(error);
      }
    });

    const readyTimer = setTimeout(() => {
      rejectReady?.(terminalError('tmux_control_ready_timeout', 'timed out waiting for tmux Control Mode attach'));
      rejectReady = null;
      resolveReady = null;
    }, timeoutMs);
    try {
      await readyPromise;
    } finally {
      clearTimeout(readyTimer);
    }
    return paneInfo;
  }

  return {
    start,
    async capturePane(scrollback = 5000, onComplete = null) {
      await start();
      const lineCount = clampInteger(scrollback, 5000, 1, 100_000);
      const response = await requestCommand(
        `capture-pane -p -e -S -${lineCount} -t ${paneInfo.pane}`,
        onComplete
      );
      return response.data;
    },
    // capture-pane replays as plain text, so the seeded copy always ends with
    // the cursor after the last captured line. On a pane whose content does not
    // fill the screen that is many rows below where tmux actually holds the
    // cursor, and every later byte then lands on the wrong row. Ask tmux for
    // the real cursor in the same write so the caller can restore it.
    async capturePaneWithCursor(scrollback = 5000, onComplete = null) {
      await start();
      const lineCount = clampInteger(scrollback, 5000, 1, 100_000);
      let capture = Buffer.alloc(0);
      let cursor = null;
      let delivered = false;

      function deliver() {
        if (delivered) {
          return;
        }
        delivered = true;
        onComplete?.(capture, cursor);
      }

      const [capturePromise, cursorPromise] = requestCommandBatch([
        {
          command: `capture-pane -p -e -S -${lineCount} -t ${paneInfo.pane}`,
          onComplete(data) {
            capture = data;
          }
        },
        {
          // The format string must be quoted: unquoted, tmux treats the leading
          // '#' as a comment and silently answers with its default status line
          // instead of the cursor position.
          command: `display-message -p -t ${paneInfo.pane} "#{cursor_x},#{cursor_y}"`,
          onComplete(data) {
            cursor = parseCursorReply(data);
            // Runs synchronously while the control stream is still inside this
            // response, so the caller seeds its copy before any later %output.
            deliver();
          }
        }
      ]);

      await capturePromise;
      try {
        await cursorPromise;
      } catch (error) {
        // A cursor query failure must not take the whole stream down; seed
        // without the restore and let the next reset correct the position.
        log.warn(`[operator-terminal] cursor query failed: ${error.message}`);
        deliver();
      }
      return { capture, cursor };
    },
    async stop() {
      stopping = true;
      if (!process) {
        return;
      }
      const child = process;
      try {
        child.stdin.write('detach-client\n');
        child.stdin.end();
      } catch {}
      const exited = new Promise((resolve) => child.once('close', resolve));
      const timer = setTimeout(() => {
        if (!child.killed) {
          child.kill('SIGTERM');
        }
      }, 500);
      await exited;
      clearTimeout(timer);
    },
    get paneInfo() {
      return paneInfo;
    }
  };
}

export function createOperatorTerminalTransport(options = {}) {
  const sessionId = asNonEmptyString(options.sessionId) ?? 'default';
  const tmuxController = options.tmuxController;
  if (!tmuxController) {
    throw new Error('tmuxController is required');
  }
  const sendPayload = typeof options.sendPayload === 'function' ? options.sendPayload : () => false;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const log = toLogger(options.log ?? console);
  const scrollback = clampInteger(options.scrollback, 5000, 100, 100_000);
  const batchDelayMs = clampInteger(options.batchDelayMs, 500, 1, 1000);
  const batchMaxBytes = clampInteger(options.batchMaxBytes, 16 * 1024, 256, 1024 * 1024);
  const restartDelayMs = clampInteger(options.restartDelayMs, 750, 100, 30_000);
  const createClient = typeof options.createClient === 'function'
    ? options.createClient
    : (clientOptions) => createTmuxControlModeClient(clientOptions);
  const createState = typeof options.createState === 'function'
    ? options.createState
    : (stateOptions) => createHeadlessTerminalState(stateOptions);
  const subscribers = new Set();
  const acknowledgedBySubscriber = new Map();
  const pendingResetSubscribers = new Set();
  let pendingBroadcastReset = false;
  let client = null;
  let state = null;
  let pane = null;
  let cols = 80;
  let rows = 24;
  let generation = 0;
  let sequence = 0;
  let startPromise = null;
  let resetQueue = Promise.resolve();
  let deliveryPaused = true;
  let stoppingClient = false;
  let closed = false;
  let restartTimer = null;
  let hasReset = false;
  let deferredBatches = [];

  function emit(payload) {
    return sendPayload({ v: 1, ts: now(), session_id: sessionId, ...payload });
  }

  const batcher = createTerminalOutputBatcher({
    maxDelayMs: batchDelayMs,
    maxBytes: batchMaxBytes,
    onBatch(data) {
      if (deliveryPaused) {
        deferredBatches.push(data);
        return;
      }
      if (subscribers.size === 0 || !pane) {
        return;
      }
      sequence += 1;
      emit({
        type: 'operator_terminal_data',
        pane,
        generation,
        seq: sequence,
        data_base64: data.toString('base64')
      });
    }
  });

  function resumeDeferredBatches() {
    if (deferredBatches.length === 0) {
      return;
    }
    const batches = deferredBatches;
    deferredBatches = [];
    for (const batch of batches) {
      batcher.push(batch);
    }
  }

  function handleOutput(data) {
    if (!state || data.length === 0) {
      return;
    }
    void state.write(data).catch((error) => {
      log.warn(`[operator-terminal] headless write failed: ${error.message}`);
    });
    batcher.push(data);
  }

  function scheduleRestart(error) {
    if (closed || subscribers.size === 0 || restartTimer !== null) {
      return;
    }
    emit({ type: 'operator_terminal_error', pane, generation, reason: error?.reason ?? 'tmux_control_exited' });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void restartStream().catch((restartError) => {
        log.warn(`[operator-terminal] Control Mode restart failed: ${restartError.message}`);
        scheduleRestart(restartError);
      });
    }, restartDelayMs);
  }

  async function stopStream() {
    deliveryPaused = true;
    batcher.discard();
    deferredBatches = [];
    hasReset = false;
    pendingResetSubscribers.clear();
    pendingBroadcastReset = false;
    if (restartTimer !== null) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const oldClient = client;
    const oldState = state;
    client = null;
    state = null;
    pane = null;
    startPromise = null;
    if (oldClient) {
      stoppingClient = true;
      try {
        await oldClient.stop();
      } finally {
        stoppingClient = false;
      }
    }
    await oldState?.dispose?.();
  }

  async function startStream() {
    if (startPromise) {
      return startPromise;
    }
    startPromise = (async () => {
      generation += 1;
      sequence = 0;
      deliveryPaused = true;
      batcher.discard();
      deferredBatches = [];
      hasReset = false;
      const nextClient = createClient({
        pane: tmuxController.pane,
        timeoutMs: options.tmuxTimeoutMs,
        tmuxArgs: options.tmuxArgs,
        runCommand: options.runCommand,
        spawnProcess: options.spawnProcess,
        onOutput: handleOutput,
        onExit(error) {
          if (!stoppingClient) {
            client = null;
            startPromise = null;
            scheduleRestart(error);
          }
        },
        log
      });
      client = nextClient;
      const info = await nextClient.start();
      pane = info.pane;
      cols = info.cols;
      rows = info.rows;
      let nextState = null;
      const capturePaneWithCursor = typeof nextClient.capturePaneWithCursor === 'function'
        ? nextClient.capturePaneWithCursor.bind(nextClient)
        : (limit, onComplete) => nextClient.capturePane(limit, (capture) => onComplete(capture, null));
      await capturePaneWithCursor(scrollback, (capture, cursor) => {
        nextState = createState({ cols, rows, scrollback });
        state = nextState;
        // The capture replays as text, which parks the cursor after the last
        // captured line. Restoring tmux's real cursor keeps every later byte on
        // the row it belongs to instead of drifting down the screen.
        const restore = cursorRestoreSequence(cursor);
        const seed = restore
          ? Buffer.concat([Buffer.from(capture), Buffer.from(restore, 'utf8')])
          : capture;
        void nextState.resetFromCapture(seed).catch((error) => {
          log.warn(`[operator-terminal] capture seed failed: ${error.message}`);
        });
      });
      if (!nextState) {
        throw terminalError('tmux_capture_missing', 'Control Mode capture returned no checkpoint');
      }
      return { pane, cols, rows, generation };
    })();
    try {
      return await startPromise;
    } catch (error) {
      startPromise = null;
      const failedClient = client;
      client = null;
      try {
        await failedClient?.stop?.();
      } catch {}
      throw error;
    }
  }

  // One stalled browser can produce a burst of reset requests: every delayed
  // acknowledgement it sends carries an old generation, and each of those would
  // otherwise queue its own full-screen refresh. Any reset already on the way
  // satisfies all of them, so collapse the burst into the pending one.
  function clearPendingReset(subscriberId) {
    if (subscriberId === null) {
      pendingBroadcastReset = false;
      // A broadcast refresh reaches every subscriber, so any per-subscriber
      // request that was suppressed by it is now satisfied too.
      pendingResetSubscribers.clear();
      return;
    }
    pendingResetSubscribers.delete(subscriberId);
  }

  function hasPendingResetFor(subscriberId) {
    if (pendingBroadcastReset) {
      return true;
    }
    return subscriberId !== null && pendingResetSubscribers.has(subscriberId);
  }

  function queueReset(subscriberId = null) {
    if (hasPendingResetFor(subscriberId)) {
      return resetQueue;
    }
    if (subscriberId === null) {
      pendingBroadcastReset = true;
    } else {
      pendingResetSubscribers.add(subscriberId);
    }
    resetQueue = resetQueue.then(async () => {
      if (closed || subscribers.size === 0) {
        clearPendingReset(subscriberId);
        return false;
      }
      await startStream();
      if (hasReset) {
        deliveryPaused = false;
        resumeDeferredBatches();
        batcher.flush();
      } else {
        batcher.discard();
        deferredBatches = [];
      }
      deliveryPaused = true;
      const serialized = await state.serialize();
      emit({
        type: 'operator_terminal_reset',
        subscriber_id: subscriberId,
        pane,
        generation,
        seq: sequence,
        cols,
        rows,
        scrollback,
        data_base64: Buffer.from(serialized, 'utf8').toString('base64')
      });
      // Cleared only after the refresh is on the wire, so requests that arrive
      // while it is being produced are answered by it instead of stacking up.
      clearPendingReset(subscriberId);
      hasReset = true;
      deliveryPaused = false;
      resumeDeferredBatches();
      batcher.flush();
      return true;
    }).catch((error) => {
      clearPendingReset(subscriberId);
      deliveryPaused = false;
      log.warn(`[operator-terminal] reset failed: ${error.message}`);
      emit({
        type: 'operator_terminal_error',
        subscriber_id: subscriberId,
        pane,
        generation,
        reason: error?.reason ?? 'terminal_reset_failed'
      });
      return false;
    });
    return resetQueue;
  }

  async function restartStream() {
    if (closed || subscribers.size === 0) {
      return false;
    }
    await stopStream();
    await startStream();
    return queueReset(null);
  }

  return {
    async handleSubscribe(payload = {}) {
      const subscriberId = asNonEmptyString(payload.subscriber_id);
      if (!subscriberId) {
        return false;
      }
      subscribers.add(subscriberId);
      acknowledgedBySubscriber.set(subscriberId, 0);
      await startStream();
      await queueReset(subscriberId);
      return true;
    },
    async handleUnsubscribe(payload = {}) {
      const subscriberId = asNonEmptyString(payload.subscriber_id);
      if (!subscriberId) {
        return false;
      }
      subscribers.delete(subscriberId);
      acknowledgedBySubscriber.delete(subscriberId);
      pendingResetSubscribers.delete(subscriberId);
      if (subscribers.size === 0) {
        await stopStream();
      }
      return true;
    },
    async handleAck(payload = {}) {
      const subscriberId = asNonEmptyString(payload.subscriber_id);
      if (!subscriberId || !subscribers.has(subscriberId)) {
        return false;
      }
      if (Number(payload.generation) !== generation) {
        return queueReset(subscriberId);
      }
      const acknowledged = clampInteger(payload.seq, 0, 0, Number.MAX_SAFE_INTEGER);
      acknowledgedBySubscriber.set(subscriberId, Math.max(acknowledgedBySubscriber.get(subscriberId) ?? 0, acknowledged));
      if (payload.needs_reset === true) {
        return queueReset(subscriberId);
      }
      return true;
    },
    async handleResync(payload = {}) {
      const subscriberId = asNonEmptyString(payload.subscriber_id);
      if (!subscriberId || !subscribers.has(subscriberId)) {
        return false;
      }
      return queueReset(subscriberId);
    },
    async setPane() {
      if (subscribers.size === 0) {
        return false;
      }
      return restartStream();
    },
    async disconnectAll() {
      subscribers.clear();
      acknowledgedBySubscriber.clear();
      await stopStream();
    },
    async shutdown() {
      closed = true;
      subscribers.clear();
      acknowledgedBySubscriber.clear();
      batcher.close();
      await stopStream();
    },
    getState() {
      return {
        pane,
        cols,
        rows,
        generation,
        sequence,
        subscriberCount: subscribers.size,
        active: Boolean(client && state)
      };
    }
  };
}
