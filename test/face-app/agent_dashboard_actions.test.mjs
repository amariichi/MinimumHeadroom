import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentLifecycleActions, shouldShowMobileAgentList } from '../../face-app/public/agent_dashboard_actions.js';

test('listAgentLifecycleActions exposes expected controls per status', () => {
  const active = listAgentLifecycleActions({ status: 'active', pane_id: '%1' }).map((item) => item.action);
  assert.deepEqual(active, ['focus', 'pause', 'stop', 'remove']);

  const paused = listAgentLifecycleActions({ status: 'paused', pane_id: '%2' }).map((item) => item.action);
  assert.deepEqual(paused, ['focus', 'resume', 'stop', 'remove']);

  const removed = listAgentLifecycleActions({ status: 'removed', pane_id: '%3' }).map((item) => item.action);
  assert.deepEqual(removed, ['restore', 'delete-worktree']);
});

test('shouldShowMobileAgentList requires mobile mode and more than one non-removed agent', () => {
  const agents = [{ status: 'active' }, { status: 'paused' }];
  assert.equal(shouldShowMobileAgentList(agents, { isMobileUi: true, operatorPanelEnabled: true }), true);
  assert.equal(shouldShowMobileAgentList(agents, { isMobileUi: false, operatorPanelEnabled: true }), false);
  assert.equal(
    shouldShowMobileAgentList([{ status: 'active' }, { status: 'removed' }], { isMobileUi: true, operatorPanelEnabled: true }),
    false
  );
});

