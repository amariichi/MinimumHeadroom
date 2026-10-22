import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('public agent-state fixtures use synthetic identities and no capture provenance', () => {
  const directory = new URL('../fixtures/', import.meta.url);
  const files = readdirSync(directory).filter(name => name.endsWith('.synthetic.json'));
  assert.equal(files.length, 6);
  for (const name of files) {
    const text = readFileSync(new URL(name, directory), 'utf8');
    const fixture = JSON.parse(text);
    assert.ok(fixture.provenance.startsWith('Synthetic regression data'), `${name}: declare synthetic provenance`);
    assert.ok(!/"(?:source_sha256|source_file|source_evidence|layout_source|layout_source_sha256)"\s*:/.test(text), `${name}: omit private capture references`);
    const homes = [...text.matchAll(/\/home\/([^/\s"\\]+)/g)];
    assert.ok(homes.every(match => match[1] === 'tester'), `${name}: use only the fictitious test home`);
    const addresses = [...text.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)];
    assert.ok(addresses.every(match => /^(?:example\.(?:com|net|org)|(?:[^.]+\.)*(?:test|invalid))$/i.test(match[1])), `${name}: use reserved example email domains`);
    assert.ok(!/https?:\/\/[^\s"\\]*\.ts\.net/.test(text), `${name}: omit private tailnet addresses`);
  }
  // Cover older tracked fixture layouts too, without reading ignored local
  // captures. Keep real account values out of this test's code and diagnostics.
  const tracked = execFileSync('git', ['ls-files', '-z', '--', 'test/fixtures', 'test/face-app/fixtures'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of tracked) {
    const text = readFileSync(name, 'utf8');
    const addresses = [...text.matchAll(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g)];
    assert.ok(addresses.every(match => /^(?:example\.(?:com|net|org)|(?:[^.]+\.)*(?:test|invalid))$/i.test(match[1])), `${name}: use reserved example email domains`);
    assert.ok(!/https?:\/\/[^\s"\\]*\.ts\.net/.test(text), `${name}: omit private tailnet addresses`);
  }
});
