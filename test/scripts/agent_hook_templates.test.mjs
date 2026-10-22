import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => JSON.parse(readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8'));

for (const filename of ['examples/rmh-voice-mode/templates/codex-config.toml.tmpl',
  'doc/hook-bridge/codex-config.toml.example', 'doc/examples/codex/config.toml']) {
  test(`Codex canonical observer templates include interruption and session exit: ${filename}`, () => {
    const text = readFileSync(new URL(`../../${filename}`, import.meta.url), 'utf8');
    for (const event of ['Interrupt', 'SessionEnd']) {
      assert.match(text, new RegExp(`\\[\\[hooks\\.${event}\\]\\]`));
      assert.match(text, new RegExp(`scripts/mh-hook\\.mjs --runtime codex --event ${event}"\\ntimeout = 3`));
    }
    assert.doesNotMatch(text, /codex-hook\.mjs|dangerously-bypass-hook-trust/);
  });
}

test('Claude template observes questions and plan approval separately from permission and notification subtypes', () => {
  const { hooks } = read('examples/rmh-voice-mode/templates/claude-settings.json.tmpl');
  assert.equal(hooks.PreToolUse[0].matcher, 'AskUserQuestion|ExitPlanMode');
  assert.match(hooks.PermissionRequest[0].hooks[0].command, /--event PermissionRequest$/);
  assert.doesNotMatch(hooks.Notification[0].matcher, /permission_prompt|auth_success|agent_completed/);
  assert.match(hooks.Notification[0].hooks[0].command, /--event Notification$/);
  assert.match(hooks.PostToolUse[0].hooks[0].command, /--event PostToolUse$/);
  assert.match(hooks.PostToolBatch[0].hooks[0].command, /--event PostToolBatch$/);
  assert.equal(hooks.UserPromptSubmit[0].hooks.length, 2, 'preserve situation injection alongside state observer');
});

for (const filename of ['examples/rmh-voice-mode/templates/antigravity-plugin/hooks.json.tmpl',
  'doc/hook-bridge/antigravity-hooks.json.example', 'doc/examples/antigravity/hooks.json']) {
  test(`agy observer is passive and preserves disabled policy example: ${filename}`, () => {
    const data = read(filename);
    assert.equal(data['minimum-headroom-approval-attention-optional'].enabled, false);
    const observer = data['minimum-headroom-input-observer'];
    assert.equal(observer.PreToolUse[0].matcher, 'ask_question|ask_permission');
    for (const event of ['PreToolUse', 'PostToolUse', 'PreInvocation']) {
      const entry = observer[event][0];
      const command = (entry.hooks?.[0] ?? entry).command;
      assert.match(command, /--stdout-mode silent/);
      assert.match(command, new RegExp(`--event ${event}$`));
      assert.doesNotMatch(command, /auto.approve|decision|dangerously/);
    }
  });
}
