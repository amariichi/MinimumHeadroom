import assert from 'node:assert/strict';
import test from 'node:test';
import { listAgentLifecycleActions, shouldShowMobileAgentList } from '../../face-app/public/agent_dashboard_actions.js';

test('listAgentLifecycleActions exposes delete-only control for known statuses', () => {
  for (const status of ['active', 'missing']) {
    const actions = listAgentLifecycleActions({ status, pane_id: '%1' }).map((item) => item.action);
    assert.deepEqual(actions, ['delete']);
  }
  assert.deepEqual(listAgentLifecycleActions({ status: 'unknown' }), []);
});

test('shouldShowMobileAgentList requires mobile mode, operator panel, and picker open', () => {
  const agents = [{ status: 'active' }];
  assert.equal(
    shouldShowMobileAgentList(agents, { isMobileUi: true, operatorPanelEnabled: true, pickerOpen: true }),
    true
  );
  assert.equal(
    shouldShowMobileAgentList(agents, { isMobileUi: true, operatorPanelEnabled: true, pickerOpen: false }),
    false
  );
  assert.equal(
    shouldShowMobileAgentList(agents, { isMobileUi: false, operatorPanelEnabled: true, pickerOpen: true }),
    false
  );
  assert.equal(
    shouldShowMobileAgentList(agents, { isMobileUi: true, operatorPanelEnabled: false, pickerOpen: true }),
    false
  );
  assert.equal(
    shouldShowMobileAgentList(null, { isMobileUi: true, operatorPanelEnabled: true, pickerOpen: true }),
    false
  );
});
