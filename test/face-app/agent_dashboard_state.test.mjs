import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deriveAgentOperationalState,
  deriveAssignmentToneOptions,
  deriveAgentTileTone,
  deriveDashboardMode,
  normalizePersistedDashboardSelection,
  normalizeAgentStatus,
  normalizeDashboardAgent,
  resolveRestoredDashboardSelection,
  resolveAgentQuietActivityAt,
  shouldRefreshAgentActivityFromState,
  shouldUseAgentQuietPromptIdle,
  sortDashboardAgents,
  summarizeAgentOperationalState,
  summarizeAgentTileMessage
} from '../../face-app/public/agent_dashboard_state.js';

test('normalizeDashboardAgent keeps expected shape', () => {
  const agent = normalizeDashboardAgent(
    {
      id: 'agent-a',
      status: 'missing',
      slot: 2,
      pane_id: '%12',
      session_id: 'session-a',
      last_message: 'ready'
    },
    0
  );

  assert.equal(agent.id, 'agent-a');
  assert.equal(agent.status, 'missing');
  assert.equal(agent.slot, 2);
  assert.equal(agent.pane_id, '%12');
  assert.equal(agent.session_id, 'session-a');
  assert.equal(agent.last_message, 'ready');
});

test('normalizeAgentStatus falls back to active on unknown values', () => {
  assert.equal(normalizeAgentStatus('active'), 'active');
  assert.equal(normalizeAgentStatus('UNKNOWN'), 'active');
  assert.equal(normalizeAgentStatus(null), 'active');
});

test('sortDashboardAgents respects slot ordering', () => {
  const sorted = sortDashboardAgents([
    normalizeDashboardAgent({ id: 'c', status: 'missing', slot: 3 }),
    normalizeDashboardAgent({ id: 'b', status: 'active', slot: 3 }),
    normalizeDashboardAgent({ id: 'a', status: 'active', slot: 1 })
  ]);

  assert.deepEqual(
    sorted.map((item) => item.id),
    ['a', 'b', 'c']
  );
});

test('normalizePersistedDashboardSelection accepts current and legacy shapes', () => {
  assert.deepEqual(
    normalizePersistedDashboardSelection({
      agent_id: 'helper-a',
      stream_id: 'repo:/tmp/project',
      target_repo_root: '/tmp/project',
      pane_id: '%12',
      updated_at: 123
    }),
    {
      agentId: 'helper-a',
      streamId: 'repo:/tmp/project',
      targetRepoRoot: '/tmp/project',
      paneId: '%12',
      updatedAt: 123
    }
  );
  assert.deepEqual(
    normalizePersistedDashboardSelection('helper-b'),
    {
      agentId: 'helper-b',
      streamId: null,
      targetRepoRoot: null,
      paneId: null,
      updatedAt: 0
    }
  );
  assert.equal(normalizePersistedDashboardSelection({ agent_id: '   ' }), null);
});

test('resolveRestoredDashboardSelection restores only live agents in the active stream', () => {
  const agents = [
    normalizeDashboardAgent({ id: 'helper-a', status: 'active', pane_id: '%10' }),
    normalizeDashboardAgent({ id: 'helper-missing', status: 'missing', pane_id: '%11' }),
    normalizeDashboardAgent({ id: 'helper-unregistered', status: 'active' })
  ];

  assert.equal(
    resolveRestoredDashboardSelection(
      {
        agentId: 'helper-a',
        streamId: 'repo:/tmp/project',
        targetRepoRoot: '/tmp/project'
      },
      agents,
      {
        activeStreamId: 'repo:/tmp/project',
        activeTargetRepoRoot: '/tmp/project'
      }
    )?.agentId,
    'helper-a'
  );
  assert.equal(
    resolveRestoredDashboardSelection({ agentId: 'helper-a', streamId: 'repo:/other' }, agents, {
      activeStreamId: 'repo:/tmp/project'
    }),
    null
  );
  assert.equal(resolveRestoredDashboardSelection({ agentId: 'helper-missing' }, agents), null);
  assert.equal(resolveRestoredDashboardSelection({ agentId: 'helper-unregistered' }, agents), null);
  assert.equal(resolveRestoredDashboardSelection({ agentId: 'deleted-helper' }, agents), null);
});

test('resolveRestoredDashboardSelection allows the operator fallback explicitly', () => {
  assert.deepEqual(
    resolveRestoredDashboardSelection({ agentId: '__operator__' }, [], {
      operatorAgentId: '__operator__'
    }),
    {
      agentId: '__operator__',
      agent: null,
      selection: {
        agentId: '__operator__',
        streamId: null,
        targetRepoRoot: null,
        paneId: null,
        updatedAt: 0
      }
    }
  );
});

test('deriveDashboardMode returns multi only on desktop with multiple active agents', () => {
  const agents = [
    normalizeDashboardAgent({ id: 'a', status: 'active' }),
    normalizeDashboardAgent({ id: 'b', status: 'missing' })
  ];
  assert.equal(deriveDashboardMode(agents, { isMobileUi: false }), 'multi');
  assert.equal(deriveDashboardMode(agents, { isMobileUi: true }), 'single');
});

test('deriveDashboardMode supports additional active tiles on desktop', () => {
  const agents = [normalizeDashboardAgent({ id: 'a', status: 'active' })];
  assert.equal(deriveDashboardMode(agents, { isMobileUi: false }), 'single');
  assert.equal(deriveDashboardMode(agents, { isMobileUi: false, additionalActiveCount: 1 }), 'multi');
  assert.equal(deriveDashboardMode(agents, { isMobileUi: true, additionalActiveCount: 1 }), 'single');
});

test('shouldRefreshAgentActivityFromState seeds new agents and tracks state changes', () => {
  const previous = normalizeDashboardAgent({
    id: 'agent-a',
    status: 'active',
    session_id: 'agent-a',
    last_message: 'working',
    updated_at: 100
  });
  const same = normalizeDashboardAgent({
    id: 'agent-a',
    status: 'active',
    session_id: 'agent-a',
    last_message: 'working',
    updated_at: 100
  });
  const updated = normalizeDashboardAgent({
    id: 'agent-a',
    status: 'active',
    session_id: 'agent-a',
    last_message: 'finished',
    updated_at: 120
  });

  assert.equal(shouldRefreshAgentActivityFromState(null, same), true);
  assert.equal(shouldRefreshAgentActivityFromState(previous, same), false);
  assert.equal(shouldRefreshAgentActivityFromState(previous, updated), true);
});

test('deriveAgentTileTone maps the simplified visible tone model', () => {
  const active = normalizeDashboardAgent({ status: 'active' });
  const missing = normalizeDashboardAgent({ status: 'missing' });
  assert.equal(deriveAgentTileTone(active, { speaking: false }), 'active');
  assert.equal(deriveAgentTileTone(active, { speaking: true }), 'active');
  assert.equal(deriveAgentTileTone(active, { promptIdle: true }), 'prompt_idle');
  assert.equal(deriveAgentTileTone(active, { needsAttention: true }), 'needs_attention');
  assert.equal(deriveAgentTileTone(active, { error: true }), 'error');
  assert.equal(deriveAgentTileTone(missing, { speaking: false }), 'missing');
  assert.equal(deriveAgentTileTone(missing, { promptIdle: true }), 'missing');
});

test('shouldUseAgentQuietPromptIdle requires quiet time without attention or speech', () => {
  assert.equal(
    shouldUseAgentQuietPromptIdle({
      agentStatus: 'active',
      nowMs: 20_000,
      lastActivityAt: 10_000,
      quietMs: 8_000
    }),
    true
  );
  assert.equal(
    shouldUseAgentQuietPromptIdle({
      agentStatus: 'active',
      nowMs: 17_000,
      lastActivityAt: 10_000,
      quietMs: 8_000
    }),
    false
  );
  assert.equal(
    shouldUseAgentQuietPromptIdle({
      agentStatus: 'active',
      nowMs: 20_000,
      lastActivityAt: 10_000,
      quietMs: 8_000,
      needsAttention: true
    }),
    false
  );
  assert.equal(
    shouldUseAgentQuietPromptIdle({
      agentStatus: 'missing',
      nowMs: 20_000,
      lastActivityAt: 10_000,
      quietMs: 8_000
    }),
    false
  );
});

test('resolveAgentQuietActivityAt falls back to persisted agent updated_at when transient activity is absent', () => {
  const agent = normalizeDashboardAgent({
    id: 'agent-a',
    status: 'active',
    updated_at: 12_345
  });
  assert.equal(resolveAgentQuietActivityAt(agent, null), 12_345);
  assert.equal(resolveAgentQuietActivityAt(agent, { lastActivityAt: 10_000, lastMirrorActivityAt: 11_000 }), 12_345);
  assert.equal(resolveAgentQuietActivityAt(agent, { lastActivityAt: 20_000, lastMirrorActivityAt: 19_000 }), 20_000);
});

test('shouldUseAgentQuietPromptIdle can succeed from persisted activity alone', () => {
  assert.equal(
    shouldUseAgentQuietPromptIdle({
      agentStatus: 'active',
      nowMs: 30_000,
      lastActivityAt: 12_000,
      quietMs: 8_000,
      speaking: false,
      needsAttention: false,
      promptNeedsAttention: false,
      error: false
    }),
    true
  );
});

test('summarizeAgentTileMessage prefers transient then persisted text', () => {
  const agent = normalizeDashboardAgent({ status: 'active', last_message: 'persisted' });
  assert.equal(summarizeAgentTileMessage(agent, 'transient'), 'transient');
  assert.equal(summarizeAgentTileMessage(agent, null), 'persisted');
  assert.equal(summarizeAgentTileMessage(normalizeDashboardAgent({ status: 'missing' })), 'missing');
});

test('deriveAssignmentToneOptions suppresses prompt idle for active missions and flags blocked delivery', () => {
  assert.deepEqual(
    deriveAssignmentToneOptions({
      delivery_state: 'acked',
      last_report_kind: 'progress'
    }),
    {
      activeMission: true,
      needsAttention: false,
      suppressPromptIdle: true
    }
  );
  assert.deepEqual(
    deriveAssignmentToneOptions({
      delivery_state: 'timeout',
      last_report_kind: 'progress'
    }),
    {
      activeMission: false,
      needsAttention: true,
      suppressPromptIdle: false
    }
  );
});

test('deriveAgentOperationalState distinguishes awaiting ack, thinking, review wait, and idle', () => {
  const agent = normalizeDashboardAgent({ id: 'helper-a', status: 'active', updated_at: 1_000 });

  assert.equal(
    deriveAgentOperationalState(agent, {
      assignment: {
        delivery_state: 'sent_to_tmux'
      }
    }),
    'awaiting_ack'
  );

  assert.equal(
    deriveAgentOperationalState(agent, {
      nowMs: 30_000,
      lastActivityAt: 24_000,
      promptIdle: false,
      assignment: {
        delivery_state: 'acked',
        last_report_kind: 'progress',
        last_report_at: 24_000
      }
    }),
    'working'
  );

  assert.equal(
    deriveAgentOperationalState(agent, {
      nowMs: 30_000,
      lastActivityAt: 10_000,
      promptIdle: false,
      recentActivityWindowMs: 5_000,
      assignment: {
        delivery_state: 'acked',
        last_report_kind: 'progress',
        last_report_at: 10_000
      }
    }),
    'thinking'
  );

  assert.equal(
    deriveAgentOperationalState(agent, {
      promptIdle: true,
      ownerInboxSummary: {
        informational_count: 1
      },
      assignment: {
        delivery_state: 'acked',
        last_report_kind: 'review_findings',
        last_report_at: 10_000
      }
    }),
    'awaiting_review'
  );

  assert.equal(
    deriveAgentOperationalState(agent, {
      promptIdle: true
    }),
    'idle'
  );
});

test('summaries expose the derived operational state text', () => {
  assert.equal(summarizeAgentOperationalState('thinking'), 'thinking');
  assert.equal(
    summarizeAgentTileMessage(normalizeDashboardAgent({ status: 'active' }), null, null, 'thinking'),
    'quiet, mission in progress'
  );
  assert.equal(
    summarizeAgentTileMessage(normalizeDashboardAgent({ status: 'active' }), null, null, 'awaiting_ack'),
    'awaiting first report'
  );
});
