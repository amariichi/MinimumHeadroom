import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  RuntimeModeError,
  createRuntimeModeApi,
  createTmuxRuntimeModeController,
  validateRuntimeSwitchBody
} from '../../face-app/dist/runtime_mode_api.js';
import { RUNTIME_TMUX_OPTIONS } from '../../face-app/dist/runtime_mode_config.js';

function request({
  method = 'GET',
  url = '/',
  headers = {},
  body = Buffer.alloc(0)
} = {}) {
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    }
  });
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

function response() {
  let statusCode = null;
  let headers = null;
  let body = '';
  return {
    writableEnded: false,
    writeHead(code, nextHeaders) {
      statusCode = code;
      headers = nextHeaders;
    },
    end(chunk = '') {
      body += String(chunk);
      this.writableEnded = true;
    },
    result() {
      return {
        statusCode,
        headers,
        json: body ? JSON.parse(body) : null
      };
    }
  };
}

test('runtime switch target accepts only exact mode and allowlisted selection fields', () => {
  assert.deepEqual(
    validateRuntimeSwitchBody({
      mode: 'interpreter',
      selection: 'gemma4-qwen3'
    }),
    {
      mode: 'interpreter',
      selection: 'gemma4-qwen3'
    }
  );
  assert.throws(
    () => validateRuntimeSwitchBody({
      mode: 'interpreter',
      selection: 'gemma4-qwen3',
      command: 'anything'
    }),
    (error) => error.code === 'invalid_request_fields'
  );
  assert.throws(
    () => validateRuntimeSwitchBody({
      mode: 'operator',
      selection: 'gemma4-qwen3'
    }),
    (error) => error.code === 'invalid_selection'
  );
  assert.throws(
    () => validateRuntimeSwitchBody({
      mode: 'shell',
      selection: 'default'
    }),
    (error) => error.code === 'invalid_mode'
  );
});

test('runtime mode API reports both allowlists without secrets or conversation data', async () => {
  const api = createRuntimeModeApi({
    mode: 'operator',
    selection: 'default',
    controller: {
      async snapshot() {
        return {
          available: true,
          operatorProfile: 'default',
          interpreterPreset: 'gemma4-qwen3',
          transition: {
            id: null,
            state: 'ready',
            targetMode: null,
            targetSelection: null,
            error: null
          }
        };
      }
    }
  });
  const output = response();
  assert.equal(
    await api.handleHttpRequest(
      request({ url: '/api/runtime/mode' }),
      output
    ),
    true
  );
  const payload = output.result().json;
  assert.equal(output.result().statusCode, 200);
  assert.equal(payload.mode, 'operator');
  assert.equal(payload.selection, 'default');
  assert.deepEqual(payload.operatorProfiles, [
    'default',
    'realtime',
    'supertonic',
    'supertonic-realtime',
    'qwen3',
    'qwen3-realtime'
  ]);
  assert.deepEqual(payload.interpreterPresets, [
    'gemma4-supertonic',
    'gemma4-qwen3',
    'nemotron-gemma4-supertonic',
    'nemotron-gemma4-qwen3'
  ]);
  assert.deepEqual(payload.savedSelections, {
    operator: 'default',
    interpreter: 'gemma4-qwen3'
  });
  assert.doesNotMatch(JSON.stringify(payload), /token|transcript|translation/i);
});

test('runtime mode API schedules an allowlisted target and returns 202', async () => {
  const calls = [];
  const api = createRuntimeModeApi({
    mode: 'interpreter',
    selection: 'gemma4-qwen3',
    controller: {
      async snapshot() {
        return { available: true };
      },
      async requestSwitch(input) {
        calls.push(input);
        return {
          transitionId: 'transition-one',
          targetMode: input.mode,
          targetSelection: input.selection
        };
      }
    }
  });
  const output = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/runtime/switch',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      mode: 'operator',
      selection: 'default'
    }))
  }), output);
  assert.equal(output.result().statusCode, 202);
  assert.equal(output.result().json.transitionId, 'transition-one');
  assert.deepEqual(calls, [{
    mode: 'operator',
    selection: 'default',
    currentMode: 'interpreter',
    currentSelection: 'gemma4-qwen3'
  }]);
});

test('runtime mode API maps duplicate switches, invalid content, and unknown presets', async () => {
  const api = createRuntimeModeApi({
    mode: 'operator',
    selection: 'default',
    controller: {
      async snapshot() {
        return { available: true };
      },
      async requestSwitch() {
        throw new RuntimeModeError('switch_in_progress', 409);
      }
    }
  });
  const conflict = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/runtime/switch',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      mode: 'interpreter',
      selection: 'gemma4-supertonic'
    }))
  }), conflict);
  assert.equal(conflict.result().statusCode, 409);
  assert.equal(conflict.result().json.error, 'switch_in_progress');

  const contentType = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/runtime/switch',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('{}')
  }), contentType);
  assert.equal(contentType.result().statusCode, 415);

  const unknown = response();
  await api.handleHttpRequest(request({
    method: 'POST',
    url: '/api/runtime/switch',
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      mode: 'interpreter',
      selection: 'unknown'
    }))
  }), unknown);
  assert.equal(unknown.result().statusCode, 400);
  assert.equal(unknown.result().json.error, 'invalid_selection');
});

test('runtime mode API ignores unrelated routes', async () => {
  const api = createRuntimeModeApi({
    mode: 'operator',
    selection: 'default',
    controller: {}
  });
  assert.equal(
    await api.handleHttpRequest(
      request({ url: '/api/operator/ui-config' }),
      response()
    ),
    false
  );
});

function fakeTmux(initial = {}) {
  const options = new Map(Object.entries(initial));
  const calls = [];
  async function execFile(_command, args) {
    calls.push([...args]);
    if (args[0] === 'display-message') {
      return { stdout: '%2\n', stderr: '' };
    }
    if (args[0] === 'show-options') {
      return {
        stdout: `${options.get(args.at(-1)) ?? ''}\n`,
        stderr: ''
      };
    }
    if (args[0] === 'set-option') {
      options.set(args.at(-2), args.at(-1));
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'wait-for' || args[0] === 'run-shell') {
      return { stdout: '', stderr: '' };
    }
    throw new Error(`unexpected tmux args: ${args.join(' ')}`);
  }
  return { options, calls, execFile };
}

test('tmux controller atomically records and schedules a nonsecret right-pane job', async () => {
  const fake = fakeTmux({
    [RUNTIME_TMUX_OPTIONS.shellPane]: '%1',
    [RUNTIME_TMUX_OPTIONS.stackPane]: '%2',
    [RUNTIME_TMUX_OPTIONS.activeMode]: 'operator',
    [RUNTIME_TMUX_OPTIONS.operatorProfile]: 'default',
    [RUNTIME_TMUX_OPTIONS.interpreterPreset]: 'gemma4-qwen3',
    [RUNTIME_TMUX_OPTIONS.transitionState]: 'ready'
  });
  const controller = createTmuxRuntimeModeController({
    paneId: '%2',
    repoRoot: '/repo',
    execFile: fake.execFile
  });
  const scheduled = await controller.requestSwitch({
    mode: 'interpreter',
    selection: 'gemma4-qwen3',
    currentMode: 'operator',
    currentSelection: 'default'
  });
  assert.equal(scheduled.targetMode, 'interpreter');
  assert.equal(
    fake.options.get(RUNTIME_TMUX_OPTIONS.transitionState),
    'switching'
  );
  const runShell = fake.calls.find(([command]) => command === 'run-shell');
  assert.ok(runShell);
  assert.match(runShell.at(-1), /runtime-mode-switch\.mjs/u);
  assert.match(runShell.at(-1), /--stack-pane '%2'/u);
  assert.doesNotMatch(runShell.at(-1), /token|secret/i);
  assert.equal(
    fake.calls.some(
      (args) => args[0] === 'respawn-pane'
    ),
    false
  );
  assert.equal(
    fake.calls.filter((args) => args[0] === 'wait-for').length,
    2
  );
});

test('tmux controller rejects a second switch and missing pane markers', async () => {
  const busyFake = fakeTmux({
    [RUNTIME_TMUX_OPTIONS.shellPane]: '%1',
    [RUNTIME_TMUX_OPTIONS.stackPane]: '%2',
    [RUNTIME_TMUX_OPTIONS.activeMode]: 'interpreter',
    [RUNTIME_TMUX_OPTIONS.operatorProfile]: 'default',
    [RUNTIME_TMUX_OPTIONS.interpreterPreset]: 'gemma4-qwen3',
    [RUNTIME_TMUX_OPTIONS.transitionState]: 'switching'
  });
  const busy = createTmuxRuntimeModeController({
    paneId: '%2',
    repoRoot: '/repo',
    execFile: busyFake.execFile
  });
  await assert.rejects(
    busy.requestSwitch({
      mode: 'operator',
      selection: 'default',
      currentMode: 'interpreter',
      currentSelection: 'gemma4-qwen3'
    }),
    (error) => error.code === 'switch_in_progress'
  );

  const missingFake = fakeTmux({
    [RUNTIME_TMUX_OPTIONS.stackPane]: '%2',
    [RUNTIME_TMUX_OPTIONS.activeMode]: 'operator'
  });
  const missing = createTmuxRuntimeModeController({
    paneId: '%2',
    repoRoot: '/repo',
    execFile: missingFake.execFile
  });
  const snapshot = await missing.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, 'runtime_pane_markers_missing');
});
