import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  buildRuntimeStackCommand,
  createTmuxRuntimeModeAdapter,
  executeRuntimeModeSwitch
} from '../../scripts/runtime-mode-switch.mjs';
import { RUNTIME_TMUX_OPTIONS } from '../../face-app/dist/runtime_mode_config.js';

function context(overrides = {}) {
  return {
    stackPane: '%2',
    shellPane: '%1',
    activeMode: 'operator',
    operatorProfile: 'default',
    interpreterPreset: 'gemma4-qwen3',
    bindHost: '0.0.0.0',
    bindPort: '8765',
    operatorUiMode: 'auto',
    operatorAudioTarget: 'browser',
    operatorAsrDevice: 'cpu',
    operatorKokoroVoice: 'jf_alpha',
    agentRepoRoot: '/work/repo',
    tmuxSession: 'interpreter',
    interpreterMtp: 'on',
    interpreterDraftTokens: '8',
    interpreterSupertonicVoice: 'F2',
    transitionId: 'transition-one',
    ...overrides
  };
}

function adapterFor({
  runtimeContext = context(),
  health = [true],
  preflightError = null
} = {}) {
  const calls = [];
  const healthResults = [...health];
  return {
    calls,
    adapter: {
      async sleep(milliseconds) {
        calls.push(['sleep', milliseconds]);
      },
      async readContext(stackPane) {
        calls.push(['readContext', stackPane]);
        return runtimeContext;
      },
      async preflight(target) {
        calls.push(['preflight', target]);
        if (preflightError) {
          throw preflightError;
        }
      },
      async stopPersistentAtomBridge() {
        calls.push(['stopPersistentAtomBridge']);
      },
      async ensurePersistentAtomBridge() {
        calls.push(['ensurePersistentAtomBridge']);
      },
      async respawnStack(input) {
        calls.push(['respawnStack', input]);
      },
      async waitForHealth(input) {
        calls.push(['waitForHealth', input]);
        return healthResults.shift() ?? false;
      },
      async markReady(target) {
        calls.push(['markReady', target]);
      },
      async markTransition(transition) {
        calls.push(['markTransition', transition]);
      }
    }
  };
}

test('operator to interpreter switches only the recorded stack pane and stops the persistent bridge', async () => {
  const fake = adapterFor();
  const result = await executeRuntimeModeSwitch({
    stackPane: '%2',
    targetMode: 'interpreter',
    targetSelection: 'nemotron-gemma4-supertonic',
    transitionId: 'transition-one'
  }, fake.adapter);
  assert.equal(result.ok, true);
  const stopIndex = fake.calls.findIndex(
    ([name]) => name === 'stopPersistentAtomBridge'
  );
  const respawnIndex = fake.calls.findIndex(([name]) => name === 'respawnStack');
  assert.ok(stopIndex >= 0 && stopIndex < respawnIndex);
  const respawn = fake.calls[respawnIndex][1];
  assert.equal(respawn.stackPane, '%2');
  assert.match(respawn.command, /run-interpreter-stack\.sh/u);
  assert.match(respawn.command, /nemotron-gemma4-supertonic/u);
  assert.match(respawn.command, /GEMMA4_MTP='on'/u);
  assert.doesNotMatch(respawn.command, /AUTH_TOKEN|secret/u);
  assert.equal(
    fake.calls.some(
      ([name, input]) => name === 'respawnStack' && input.stackPane === '%1'
    ),
    false
  );
});

test('interpreter to operator preserves the left pane recipe and selects an operator profile', async () => {
  const fake = adapterFor({
    runtimeContext: context({
      activeMode: 'interpreter',
      operatorProfile: 'supertonic',
      interpreterPreset: 'gemma4-qwen3'
    })
  });
  const result = await executeRuntimeModeSwitch({
    stackPane: '%2',
    targetMode: 'operator',
    targetSelection: 'qwen3',
    transitionId: 'transition-one'
  }, fake.adapter);
  assert.equal(result.ok, true);
  assert.equal(
    fake.calls.some(([name]) => name === 'stopPersistentAtomBridge'),
    false
  );
  assert.equal(
    fake.calls.filter(([name]) => name === 'ensurePersistentAtomBridge').length,
    1
  );
  const respawn = fake.calls.find(([name]) => name === 'respawnStack')[1];
  assert.equal(respawn.stackPane, '%2');
  assert.match(respawn.command, /run-operator-profile\.sh/u);
  assert.match(respawn.command, /--profile 'qwen3'/u);
  assert.match(respawn.command, /MH_BRIDGE_TMUX_PANE='%1'/u);
  assert.match(respawn.command, /MH_SKIP_ATOMS3R_BRIDGE='1'/u);
  assert.match(respawn.command, /MH_AGENT_SOURCE_REPO_DEFAULT='\/work\/repo'/u);
  assert.match(respawn.command, /MH_AGENT_TMUX_SESSION='interpreter'/u);
  assert.doesNotMatch(respawn.command, /MH_AGENT_DEFAULT_CMD/u);
});

test('target timeout rolls back to the exact previous interpreter preset', async () => {
  const fake = adapterFor({
    runtimeContext: context({
      activeMode: 'interpreter',
      operatorProfile: 'default',
      interpreterPreset: 'gemma4-qwen3'
    }),
    health: [false, true]
  });
  const result = await executeRuntimeModeSwitch({
    stackPane: '%2',
    targetMode: 'operator',
    targetSelection: 'supertonic',
    transitionId: 'transition-one'
  }, fake.adapter);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'rolled_back');
  const respawns = fake.calls.filter(([name]) => name === 'respawnStack');
  assert.equal(respawns.length, 2);
  assert.match(respawns[0][1].command, /run-operator-profile\.sh/u);
  assert.match(respawns[1][1].command, /run-interpreter-stack\.sh/u);
  assert.match(respawns[1][1].command, /gemma4-qwen3/u);
  assert.equal(
    fake.calls.filter(([name]) => name === 'stopPersistentAtomBridge').length,
    1
  );
  assert.equal(
    fake.calls.filter(([name]) => name === 'ensurePersistentAtomBridge').length,
    0
  );
  assert.deepEqual(fake.calls.at(-1), [
    'markTransition',
    { state: 'rolled_back', error: 'target_not_ready' }
  ]);
});

test('rollback failure stops after one attempt and records a bounded failure', async () => {
  const fake = adapterFor({
    health: [false, false]
  });
  const result = await executeRuntimeModeSwitch({
    stackPane: '%2',
    targetMode: 'interpreter',
    targetSelection: 'gemma4-supertonic',
    transitionId: 'transition-one'
  }, fake.adapter);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'failed');
  assert.equal(
    fake.calls.filter(([name]) => name === 'respawnStack').length,
    2
  );
  assert.deepEqual(fake.calls.at(-1), [
    'markTransition',
    { state: 'failed', error: 'rollback_failed' }
  ]);
});

test('stack command builder rejects values outside the fixed allowlists', () => {
  assert.throws(
    () => buildRuntimeStackCommand({
      mode: 'interpreter',
      selection: 'gemma4-qwen3; touch /tmp/no',
      context: context()
    }),
    /invalid_runtime_target/u
  );
});

test('runtime adapter accepts only the expected mode and selection from health', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      ok: true,
      service: 'operator',
      profile: 'qwen3'
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = String(server.address().port);
  const adapter = createTmuxRuntimeModeAdapter({
    timeoutMs: 1_000,
    pollIntervalMs: 50
  });
  assert.equal(await adapter.waitForHealth({
    mode: 'operator',
    selection: 'qwen3',
    port
  }), true);
});

test('runtime adapter stops waiting as soon as the replacement pane dies', async () => {
  const values = new Map([
    [RUNTIME_TMUX_OPTIONS.shellPane, '%1'],
    [RUNTIME_TMUX_OPTIONS.stackPane, '%2'],
    [RUNTIME_TMUX_OPTIONS.activeMode, 'operator'],
    [RUNTIME_TMUX_OPTIONS.operatorProfile, 'default'],
    [RUNTIME_TMUX_OPTIONS.interpreterPreset, 'gemma4-qwen3'],
    [RUNTIME_TMUX_OPTIONS.bindPort, '8765'],
    [RUNTIME_TMUX_OPTIONS.transitionId, 'transition-one']
  ]);
  let fetchCalls = 0;
  const adapter = createTmuxRuntimeModeAdapter({
    execFile: async (_command, args) => {
      if (args[0] === 'show-options') {
        return { stdout: `${values.get(args.at(-1)) ?? ''}\n` };
      }
      if (args[0] === 'display-message') {
        return {
          stdout: args.at(-1) === '#{pane_id}'
            ? '%2\n'
            : args.at(-1) === '#{session_name}'
              ? 'interpreter\n'
              : '%2:1\n'
        };
      }
      throw new Error(`unexpected tmux args: ${args.join(' ')}`);
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('health should not be queried');
    },
    timeoutMs: 1_000,
    pollIntervalMs: 50
  });
  const runtimeContext = await adapter.readContext('%2');
  assert.equal(runtimeContext.tmuxSession, 'interpreter');
  assert.equal(await adapter.waitForHealth({
    mode: 'interpreter',
    selection: 'gemma4-qwen3',
    port: '8765'
  }), false);
  assert.equal(fetchCalls, 0);
});

test('runtime adapter waits for the verified persistent Atom bridge to exit', async () => {
  const calls = [];
  let pgrepCalls = 0;
  const adapter = createTmuxRuntimeModeAdapter({
    execFile: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'tmux' && args[0] === 'has-session') {
        return { stdout: '' };
      }
      if (command === 'tmux' && args[0] === 'show-options') {
        return { stdout: 'operator\n' };
      }
      if (command === 'tmux' && args[0] === 'kill-session') {
        return { stdout: '' };
      }
      if (command === 'pgrep') {
        pgrepCalls += 1;
        if (pgrepCalls < 3) {
          return { stdout: '123\n' };
        }
        throw new Error('no process');
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    sleep: async (milliseconds) => {
      calls.push(['sleep', milliseconds]);
    }
  });
  await adapter.stopPersistentAtomBridge();
  assert.equal(pgrepCalls, 3);
  assert.equal(
    calls.some(
      ([command, ...args]) =>
        command === 'tmux' && args[0] === 'kill-session'
    ),
    true
  );
  assert.equal(
    calls.filter(([command]) => command === 'sleep').length,
    2
  );
});
