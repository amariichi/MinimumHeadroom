import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  evaluateAgyHelperPolicy,
  extractCommandLine,
  isGitPushCommand,
  isReviewerReadCommand,
  runAgyHelperPolicy
} from '../../scripts/agy-helper-policy.mjs';

function payload(command) {
  return { toolCall: { name: 'run_command', args: { CommandLine: command } } };
}

test('agy helper policy extracts current and compatibility command fields', () => {
  assert.equal(extractCommandLine(payload('npm test')), 'npm test');
  assert.equal(extractCommandLine({ toolCall: { args: { command: 'git status' } } }), 'git status');
});

test('agy helper policy detects direct and globally-optioned git push', () => {
  assert.equal(isGitPushCommand('git push origin main'), true);
  assert.equal(isGitPushCommand('/usr/bin/git -C /tmp/repo push'), true);
  assert.equal(isGitPushCommand('git -c core.askPass=true push'), true);
  assert.equal(isGitPushCommand('git status'), false);
});

test('agy reviewer read allowlist rejects compound and mutating commands', () => {
  assert.equal(isReviewerReadCommand('git status --short'), true);
  assert.equal(isReviewerReadCommand('rg -n TODO src'), true);
  assert.equal(isReviewerReadCommand("rg --pre 'touch /tmp/x' TODO src"), false);
  assert.equal(isReviewerReadCommand('sed -n 1,20p README.md'), true);
  assert.equal(isReviewerReadCommand('sed -i s/a/b/ README.md'), false);
  assert.equal(isReviewerReadCommand('sed --in-place=.bak s/a/b/ README.md'), false);
  assert.equal(isReviewerReadCommand("sed -n '1e touch /tmp/x' README.md"), false);
  assert.equal(isReviewerReadCommand("git -c core.pager='touch /tmp/x' log"), false);
  assert.equal(isReviewerReadCommand('git diff --output=review.patch'), false);
  assert.equal(isReviewerReadCommand('git status; rm -rf /tmp/x'), false);
  assert.equal(isReviewerReadCommand('npm test'), false);
});

test('agy helper policy asks when its managed-helper preset is missing', () => {
  assert.equal(evaluateAgyHelperPolicy(payload('git push'), null).decision, 'ask');
  assert.equal(evaluateAgyHelperPolicy(payload('git push'), 'unknown').decision, 'ask');
});

test('agy helper policy serializes a valid ask decision without a preset', async () => {
  const chunks = [];
  const result = await runAgyHelperPolicy({
    stdin: Readable.from([JSON.stringify(payload('ls'))]),
    stdout: { write: (chunk) => chunks.push(chunk) },
    env: {}
  });
  assert.equal(result.decision, 'ask');
  assert.equal(JSON.parse(chunks.join('')).decision, 'ask');
});

test('agy helper policy gates reviewer commands and denies every helper git push', () => {
  assert.deepEqual(evaluateAgyHelperPolicy(payload('git status'), 'reviewer'), { decision: 'allow' });
  assert.equal(evaluateAgyHelperPolicy(payload('npm test'), 'reviewer').decision, 'force_ask');
  assert.equal(evaluateAgyHelperPolicy(payload('git push'), 'reviewer').decision, 'deny');
  assert.equal(evaluateAgyHelperPolicy(payload('git push'), 'implementer').decision, 'deny');
  assert.deepEqual(evaluateAgyHelperPolicy(payload('npm test'), 'implementer'), { decision: 'allow' });
});
