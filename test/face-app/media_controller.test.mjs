import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMediaController,
  parseMediaAllowedEndpoints,
} from '../../face-app/dist/media_controller.js';

test('media endpoint allowlist ignores unsafe configuration and matches exact paths', () => {
  const warnings = [];
  const allowedEndpoints = parseMediaAllowedEndpoints(
    'http://127.0.0.1:9000/live.mp3,https://example.test/program.mp3,http://user:pass@bad.test/live.mp3,http://bad.test/live.mp3?x=1',
    { log: { warn: (message) => warnings.push(message) } }
  );
  assert.equal(allowedEndpoints.length, 2);
  assert.equal(warnings.length, 2);

  const controller = createMediaController({
    allowedEndpoints,
    randomToken: () => 'a'.repeat(48),
  });
  const state = controller.play({
    upstream_url: 'http://127.0.0.1:9000/live.mp3?generation=7',
    media_id: 'fixture-7',
    title: 'Fixture',
  });
  assert.equal(state.state, 'active');
  assert.equal(state.mime_type, 'audio/mpeg');
  assert.equal(state.bitrate, 128000);
  assert.ok(!JSON.stringify(state).includes('127.0.0.1'));
  assert.throws(() => controller.play({
    upstream_url: 'http://127.0.0.1:9000/pcm',
    media_id: 'bad',
    title: 'Bad',
  }), (error) => error.code === 'upstream_not_allowed');
});

test('media play is atomic, bounded, revocable, and stop is idempotent', () => {
  let tokenCounter = 0;
  const broadcasts = [];
  const controller = createMediaController({
    allowedEndpoints: [new URL('http://127.0.0.1:9000/live.mp3')],
    randomToken: () => String(++tokenCounter).padStart(48, '0'),
    broadcast: (payload) => broadcasts.push(payload),
  });
  const first = controller.play({
    upstream_url: 'http://127.0.0.1:9000/live.mp3?generation=1',
    media_id: 'one',
    title: 'One',
  });
  const firstToken = decodeURIComponent(first.stream_url.split('/').at(-1));
  const abortController = new AbortController();
  controller.attachAbortController(firstToken, abortController);

  assert.throws(() => controller.play({
    upstream_url: 'http://127.0.0.1:9000/live.mp3?generation=2',
    media_id: 'two',
    title: 'Two',
    bitrate: 96000,
  }), (error) => error.code === 'unsupported_field');
  assert.equal(controller.status().media_id, 'one');
  assert.equal(abortController.signal.aborted, false);

  const second = controller.play({
    upstream_url: 'http://127.0.0.1:9000/live.mp3?generation=2',
    media_id: 'two',
    title: 'Two',
    subtitle: 'Fixture source',
  });
  assert.equal(abortController.signal.aborted, true);
  assert.equal(controller.resolve(firstToken), null);
  assert.equal(second.revision, first.revision + 1);

  const stopped = controller.stop();
  const stoppedAgain = controller.stop();
  assert.equal(stopped.state, 'idle');
  assert.equal(stoppedAgain.revision, stopped.revision);
  assert.equal(broadcasts.length, 3);
});

test('media controller expires abandoned opaque handles', () => {
  let clock = 1000;
  const controller = createMediaController({
    allowedEndpoints: [new URL('http://127.0.0.1:9000/live.mp3')],
    randomToken: () => 'z'.repeat(48),
    now: () => clock,
    maxLifetimeMs: 50,
  });
  const active = controller.play({
    upstream_url: 'http://127.0.0.1:9000/live.mp3',
    media_id: 'expiring',
    title: 'Expiring',
  });
  const token = decodeURIComponent(active.stream_url.split('/').at(-1));
  clock += 51;
  assert.equal(controller.resolve(token), null);
  assert.equal(controller.status().state, 'idle');
});
