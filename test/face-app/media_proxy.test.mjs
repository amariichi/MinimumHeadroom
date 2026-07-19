import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { createMediaApi } from '../../face-app/dist/media_api.js';
import { createMediaController } from '../../face-app/dist/media_controller.js';
import { createMediaProxy } from '../../face-app/dist/media_proxy.js';

async function listen(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('media proxy forwards only validated MP3 bytes and hides the upstream URL', async (t) => {
  const upstream = await listen((request, response) => {
    if (request.url.startsWith('/live.mp3')) {
      response.writeHead(200, {
        'content-type': 'audio/mpeg',
        'x-media-nominal-bitrate': '128000',
        'set-cookie': 'secret=do-not-forward',
      });
      response.end(Buffer.from('fixture-mp3'));
      return;
    }
    response.writeHead(404).end();
  });
  t.after(upstream.close);

  const controller = createMediaController({
    allowedEndpoints: [new URL(upstream.origin + '/live.mp3')],
    randomToken: () => 'm'.repeat(48),
  });
  const proxy = createMediaProxy({ controller });
  const api = createMediaApi({ controller, proxy });
  const face = await listen((request, response) => {
    Promise.resolve(api.handleHttpRequest(request, response)).then((handled) => {
      if (!handled && !response.writableEnded) response.writeHead(404).end();
    });
  });
  t.after(face.close);

  const active = controller.play({
    upstream_url: upstream.origin + '/live.mp3?generation=5',
    media_id: 'fixture',
    title: 'Fixture title',
  });
  assert.ok(!JSON.stringify(active).includes(upstream.origin));
  const response = await fetch(face.origin + active.stream_url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.equal(response.headers.get('x-media-nominal-bitrate'), '128000');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(await response.text(), 'fixture-mp3');
});

test('media proxy rejects redirects and wrong bitrate before forwarding bytes', async (t) => {
  const upstream = await listen((request, response) => {
    if (request.url.startsWith('/redirect.mp3')) {
      response.writeHead(302, { location: '/valid.mp3' }).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'audio/mpeg',
      'x-media-nominal-bitrate': '96000',
    });
    response.end('wrong-policy');
  });
  t.after(upstream.close);

  for (const path of ['/redirect.mp3', '/wrong.mp3']) {
    const controller = createMediaController({
      allowedEndpoints: [new URL(upstream.origin + path)],
      randomToken: () => (path.includes('redirect') ? 'r' : 'w').repeat(48),
    });
    const active = controller.play({
      upstream_url: upstream.origin + path,
      media_id: path,
      title: path,
    });
    const token = decodeURIComponent(active.stream_url.split('/').at(-1));
    const proxy = createMediaProxy({ controller, log: { warn() {} } });
    const face = await listen((request, response) => proxy.handle(request, response, token));
    const response = await fetch(face.origin + '/stream');
    assert.equal(response.status, 502);
    assert.ok(['upstream_redirect', 'invalid_nominal_bitrate'].includes((await response.json()).error));
    assert.equal(controller.status().state, 'error');
    await face.close();
  }
});
