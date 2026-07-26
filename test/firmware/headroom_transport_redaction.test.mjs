import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const transportSourceUrl = new URL(
  '../../firmware/atoms3r-headroom/src/headroom_transport.cpp',
  import.meta.url
);

test('Atom transport never prints its token-bearing WebSocket path', async () => {
  const source = await readFile(transportSourceUrl, 'utf8');
  const connectionLog = source
    .split('\n')
    .find((line) => line.includes('Serial.printf("ws connecting'));

  assert.ok(connectionLog, 'expected a serial connection-status log');
  assert.match(connectionLog, /auth_configured=%s/);
  assert.doesNotMatch(connectionLog, /,\s*path\.c_str\(\)/);
  assert.match(source, /url\.path\.c_str\(\), settings\.authToken\.length\(\) > 0/);
  assert.match(
    source,
    /ws_\.begin\(url\.host\.c_str\(\), url\.port, path\.c_str\(\)\)/,
    'the authenticated path must still be used for the actual connection'
  );
});
