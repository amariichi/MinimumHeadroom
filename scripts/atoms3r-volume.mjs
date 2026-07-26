#!/usr/bin/env node
// Change the connected Atom's M5Unified speaker master volume without reboot.
// The HTTP endpoint is runtime-only: the saved baseline is restored at reboot.

import fs from 'node:fs';
import os, { networkInterfaces } from 'node:os';
import path from 'node:path';

const DEFAULT_ATOM_URL = 'http://atom-headroom.local';
const MAX_ATOM_SPEAKER_VOLUME = 200;
const PRESETS = Object.freeze({
  indoor: 112,
  outdoor: 160,
  mute: 0,
});

function usage() {
  console.log(`atoms3r-volume — temporarily change Atom speaker volume

Options:
  --volume <0..200>     exact safe speaker volume
  --preset <name>       faced-Atom preset: indoor (112), outdoor (160), mute (0)
  --url <base|auto>     Atom HTTP base (default: ATOM_HEADROOM_URL or auto)
  --device-id <id>      expected device id (default: atom-headroom-1)
  --token <token>       auth token (else ATOM_HEADROOM_AUTH_TOKEN,
                        MH_FACE_AUTH_TOKEN, or the shared env file)
  --timeout-ms <n>      health/POST timeout in ms (default: 3000)
  --dry-run             validate and print the redacted action without network I/O
  --help                show this help

The change is immediate but is not saved to NVS. Use atoms3r-provision.mjs
--speaker-volume <n> to change the baseline restored at reboot.
`);
}

function parseArgs(argv) {
  const options = {
    timeoutMs: 3000,
    dryRun: false,
  };
  const take = (index, name) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--volume') options.volume = take(index++, arg);
    else if (arg === '--preset') options.preset = take(index++, arg);
    else if (arg === '--url') options.url = take(index++, arg);
    else if (arg === '--device-id') options.deviceId = take(index++, arg);
    else if (arg === '--token') options.token = take(index++, arg);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(take(index++, arg));
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`unknown arg: ${arg}`);
  }
  return options;
}

function resolveVolume(options) {
  if (options.volume !== undefined && options.preset !== undefined) {
    throw new Error('pass exactly one of --volume or --preset');
  }
  if (options.volume === undefined && options.preset === undefined) {
    throw new Error('pass exactly one of --volume or --preset');
  }
  if (options.preset !== undefined) {
    const name = String(options.preset).trim().toLowerCase();
    if (!Object.hasOwn(PRESETS, name)) {
      throw new Error('--preset must be indoor, outdoor, or mute');
    }
    return { volume: PRESETS[name], preset: name };
  }
  const volume = Number(options.volume);
  if (!Number.isInteger(volume) || volume < 0 || volume > MAX_ATOM_SPEAKER_VOLUME) {
    throw new Error('--volume must be an integer between 0 and 200');
  }
  return { volume, preset: null };
}

function readEnvFileVar(file, name) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || match[1] !== name) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    // A missing per-user config is valid.
  }
  return '';
}

function tokenFromUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('auth_token') ?? parsed.searchParams.get('token') ?? '';
  } catch {
    return '';
  }
}

function resolveToken(options, configuredInput) {
  if (options.token !== undefined) return options.token;
  if (process.env.ATOM_HEADROOM_AUTH_TOKEN) return process.env.ATOM_HEADROOM_AUTH_TOKEN;
  if (process.env.MH_FACE_AUTH_TOKEN) return process.env.MH_FACE_AUTH_TOKEN;
  const urlToken = tokenFromUrl(configuredInput);
  if (urlToken) return urlToken;
  const sharedEnv = process.env.MH_SHARED_ENV_FILE
    || path.join(os.homedir(), '.config/minimum-headroom.env');
  return readEnvFileVar(sharedEnv, 'ATOM_HEADROOM_AUTH_TOKEN')
    || readEnvFileVar(sharedEnv, 'MH_FACE_AUTH_TOKEN');
}

function isAuto(value) {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'auto';
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Atom URL must use http or https: ${value}`);
  }
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function authHeaders(token) {
  return token ? { 'x-headroom-auth': token } : {};
}

function isExpectedHealth(payload, expectedDeviceId) {
  return payload?.ok === true
    && payload?.service === 'atoms3r-headroom'
    && (!expectedDeviceId || payload.device_id === expectedDeviceId);
}

async function probeHealth(baseUrl, token, expectedDeviceId, timeoutMs) {
  try {
    const response = await fetch(new URL('/health', baseUrl), {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    return isExpectedHealth(payload, expectedDeviceId) ? payload : null;
  } catch {
    return null;
  }
}

function parseDiscoverySubnets(value) {
  const prefixes = [];
  for (const raw of String(value ?? '').split(/[,\s]+/)) {
    if (!raw) continue;
    const match = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?(?:\/24)?$/);
    if (!match) continue;
    const octets = match.slice(1).map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) continue;
    prefixes.push(octets.join('.'));
  }
  return prefixes;
}

function discoveryCandidates(configuredUrl) {
  const urls = new Set([configuredUrl, normalizeBaseUrl(DEFAULT_ATOM_URL)]);
  const prefixes = new Set(parseDiscoverySubnets(process.env.ATOM_HEADROOM_DISCOVERY_SUBNETS));
  for (const info of Object.values(networkInterfaces()).flat()) {
    if (!info || info.family !== 'IPv4' || info.internal) continue;
    const octets = info.address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) continue;
    prefixes.add(octets.slice(0, 3).join('.'));
  }
  for (const prefix of prefixes) {
    for (let host = 1; host <= 254; host += 1) {
      urls.add(`http://${prefix}.${host}/`);
    }
  }
  return [...urls];
}

async function discoverAtom(configuredUrl, token, expectedDeviceId) {
  const direct = await probeHealth(configuredUrl, token, expectedDeviceId, 3000);
  if (direct) return { baseUrl: configuredUrl, health: direct };
  if (process.env.ATOM_HEADROOM_DISCOVERY === '0') {
    throw new Error(`Atom is not reachable at ${configuredUrl}`);
  }

  const candidates = discoveryCandidates(configuredUrl);
  const timeoutMs = Number.parseInt(process.env.ATOM_HEADROOM_DISCOVERY_TIMEOUT_MS ?? '450', 10) || 450;
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.ATOM_HEADROOM_DISCOVERY_CONCURRENCY ?? '32', 10) || 32,
  );
  let cursor = 0;
  let found = null;
  async function worker() {
    while (!found && cursor < candidates.length) {
      const baseUrl = candidates[cursor++];
      const health = await probeHealth(baseUrl, token, expectedDeviceId, timeoutMs);
      if (health && !found) found = { baseUrl, health };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
  if (!found) throw new Error('Atom discovery found no matching /health endpoint');
  return found;
}

async function main() {
  const options = parseArgs(process.argv);
  if (options.help) {
    usage();
    return;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30000) {
    throw new Error('--timeout-ms must be an integer between 100 and 30000');
  }
  const selected = resolveVolume(options);
  const configuredInput = options.url ?? process.env.ATOM_HEADROOM_URL;
  const configuredUrl = normalizeBaseUrl(isAuto(configuredInput) ? DEFAULT_ATOM_URL : configuredInput);
  const expectedDeviceId = options.deviceId ?? process.env.ATOM_HEADROOM_DEVICE_ID ?? 'atom-headroom-1';
  const token = resolveToken(options, configuredInput);

  if (selected.volume > 200) {
    console.warn('warning: values above 200 may increase distortion, power draw, and speaker stress');
  }
  if (options.dryRun) {
    console.log(JSON.stringify({
      url: isAuto(configuredInput) ? 'auto' : configuredUrl,
      device_id: expectedDeviceId,
      speaker_volume: selected.volume,
      preset: selected.preset,
      persistent: false,
    }));
    return;
  }

  const found = await discoverAtom(configuredUrl, token, expectedDeviceId);
  if (!Number.isInteger(found.health.speaker_volume)) {
    throw new Error('Atom firmware does not expose speaker_volume; flash the updated firmware first');
  }
  const previous = found.health.speaker_volume;
  const response = await fetch(new URL('/api/headroom/volume', found.baseUrl), {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ volume: selected.volume }),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const responseText = await response.text();
  let payload = null;
  try { payload = JSON.parse(responseText); } catch { /* reported below */ }
  if (!response.ok || payload?.ok !== true || payload?.speaker_volume !== selected.volume) {
    throw new Error(`Atom volume request failed status=${response.status} body=${responseText.slice(0, 160)}`);
  }

  const verified = await probeHealth(
    found.baseUrl,
    token,
    expectedDeviceId,
    options.timeoutMs,
  );
  if (!verified || verified.speaker_volume !== selected.volume) {
    throw new Error('Atom accepted the volume request, but /health did not confirm the new value');
  }
  console.log(
    `Atom ${expectedDeviceId} speaker volume ${previous} -> ${selected.volume}`
    + ' (temporary; saved reboot baseline unchanged)',
  );
}

main().catch((error) => {
  console.error(`atoms3r-volume: ${error.message}`);
  process.exit(1);
});
