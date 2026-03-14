import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveAgentTileTone,
  deriveOwnerInboxToneOptions,
  normalizeDashboardAgent,
  summarizeAgentTileMessage,
  summarizeOwnerInboxSummary
} from '../../face-app/public/agent_dashboard_state.js';

test('owner inbox tone options surface blocking attention and errors', () => {
  assert.deepEqual(
    deriveOwnerInboxToneOptions({
      unresolved_count: 2,
      blocking_count: 0,
      error_count: 0
    }),
    {
      needsAttention: false,
      error: false
    }
  );
  assert.deepEqual(
    deriveOwnerInboxToneOptions({
      unresolved_count: 1,
      blocking_count: 1,
      error_count: 1
    }),
    {
      needsAttention: true,
      error: true
    }
  );
});

test('owner inbox summaries prefer explicit report text and fall back to counts', () => {
  assert.equal(
    summarizeOwnerInboxSummary({
      summary: 'Need user approval'
    }),
    'Need user approval'
  );
  assert.equal(
    summarizeOwnerInboxSummary({
      unresolved_count: 2
    }),
    '2 unresolved reports'
  );
});

test('tile messages prefer transient text, then owner inbox summary, then persisted text', () => {
  const agent = normalizeDashboardAgent({
    status: 'active',
    last_message: 'persisted status'
  });

  assert.equal(summarizeAgentTileMessage(agent, 'transient status', 'owner inbox status'), 'transient status');
  assert.equal(summarizeAgentTileMessage(agent, null, 'owner inbox status'), 'owner inbox status');
  assert.equal(summarizeAgentTileMessage(agent, null, null), 'persisted status');
});

test('owner inbox blocking state drives the visible attention tone', () => {
  const agent = normalizeDashboardAgent({
    id: 'helper-a',
    status: 'active'
  });
  const tone = deriveAgentTileTone(agent, {
    ...deriveOwnerInboxToneOptions({
      unresolved_count: 1,
      blocking_count: 1,
      error_count: 0
    })
  });
  assert.equal(tone, 'needs_attention');
});

test('informational owner inbox items keep the visible tone active', () => {
  const agent = normalizeDashboardAgent({
    id: 'helper-a',
    status: 'active'
  });
  const tone = deriveAgentTileTone(agent, {
    ...deriveOwnerInboxToneOptions({
      unresolved_count: 1,
      blocking_count: 0,
      error_count: 0
    })
  });
  assert.equal(tone, 'active');
});
