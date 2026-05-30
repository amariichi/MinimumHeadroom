#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const DEFAULT_FACE_WS_URL = 'ws://127.0.0.1:8765/ws';
const DEFAULT_ATOM_URL = 'http://192.168.1.33';
const DEFAULT_MAX_PAYLOAD_BYTES = 1_050_000;
const DEFAULT_MOUTH_INTERVAL_MS = 80;

const faceWsUrlInput = process.env.FACE_WS_URL ?? process.env.MH_FACE_WS_URL ?? DEFAULT_FACE_WS_URL;
const configuredAtomBaseUrl = normalizeBaseUrl(process.env.ATOM_HEADROOM_URL ?? DEFAULT_ATOM_URL);
const localConfigToken = readLocalHeadroomToken();
const faceAuthToken = process.env.MH_FACE_AUTH_TOKEN ?? tokenFromUrl(faceWsUrlInput) ?? localConfigToken ?? '';
const atomAuthToken = process.env.ATOM_HEADROOM_AUTH_TOKEN ?? faceAuthToken;
const maxPayloadBytes = positiveInt(process.env.ATOM_HEADROOM_MAX_PAYLOAD_BYTES, DEFAULT_MAX_PAYLOAD_BYTES);
const mouthIntervalMs = positiveInt(process.env.ATOM_HEADROOM_MOUTH_INTERVAL_MS, DEFAULT_MOUTH_INTERVAL_MS);
const forwardAudio = process.env.ATOM_HEADROOM_FORWARD_AUDIO !== '0';
const fetchAudioRef = process.env.ATOM_HEADROOM_FETCH_AUDIO_REF === '1';
const discoveryEnabled = process.env.ATOM_HEADROOM_DISCOVERY !== '0';
const discoveryTimeoutMs = positiveInt(process.env.ATOM_HEADROOM_DISCOVERY_TIMEOUT_MS, 450);
const discoveryConcurrency = positiveInt(process.env.ATOM_HEADROOM_DISCOVERY_CONCURRENCY, 32);
const expectedDeviceId = normalizeOptionalString(process.env.ATOM_HEADROOM_DEVICE_ID ?? 'atom-headroom-1');
// Extra /24 subnets to sweep during Atom discovery, beyond the PC's directly
// attached interfaces. Needed when the Atom sits on a subnet the PC can route to
// but isn't locally attached to — e.g. a travel router's LAN (192.168.8.0/24)
// reachable over a Tailscale subnet route. Comma/space separated; each entry is
// "a.b.c.0/24" or a bare "a.b.c" /24 prefix. Pairs with the firmware mDNS
// feature so both directions self-heal as the Atom roams.
const discoverySubnets = parseDiscoverySubnets(process.env.ATOM_HEADROOM_DISCOVERY_SUBNETS);

const faceWsUrl = withAuthQuery(faceWsUrlInput, faceAuthToken);
const faceHttpBase = httpBaseFromWsUrl(faceWsUrl);
const relayTypes = new Set(['event', 'tts_state', 'tts_mouth', 'tts_audio']);

let ws = null;
let reconnectTimer = null;
let postChain = Promise.resolve();
let atomBaseUrl = configuredAtomBaseUrl;
let atomPayloadUrl = '';
let atomAudioUrl = '';
let atomHealthUrl = '';
refreshAtomUrls();
// Highest tts generation seen. On a barge-in/interrupt the server bumps the
// generation; queued audio for an older generation must be dropped at send
// time instead of being flushed to the Atom in a burst (the burst makes the
// firmware stop/replay rapidly and the async I2S playback corrupts = static).
let latestGeneration = 0;

function observeGeneration(payload) {
  const g = payload?.generation;
  if (Number.isInteger(g) && g > latestGeneration) {
    latestGeneration = g;
  }
}

function resetGenerationWindow(reason) {
  if (latestGeneration !== 0) {
    console.log(`[atoms3r-bridge] reset generation window (${reason}); previous=${latestGeneration}`);
  }
  latestGeneration = 0;
}
let lastMouthForwardedAt = 0;
let lastMouthOpen = null;

if (typeof WebSocket !== 'function') {
  console.error('[atoms3r-bridge] Node.js global WebSocket is unavailable. Use Node 22+.');
  process.exit(1);
}

console.log(
  `[atoms3r-bridge] face_ws=${redactUrl(faceWsUrl)} atom=${redactUrl(atomBaseUrl)} max_payload=${maxPayloadBytes} forward_audio=${forwardAudio} fetch_audio_ref=${fetchAudioRef} discovery=${discoveryEnabled}${discoverySubnets.length ? ` discovery_subnets=${discoverySubnets.map((p) => `${p}.0/24`).join(',')}` : ''}`
);

await ensureAtomReachable('startup');
connect();

process.on('SIGINT', () => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  if (ws) {
    ws.close();
  }
  process.exit(0);
});

function connect() {
  ws = new WebSocket(faceWsUrl);

  ws.addEventListener('open', () => {
    resetGenerationWindow('websocket_open');
    console.log('[atoms3r-bridge] connected to face-app websocket');
  });

  ws.addEventListener('message', (event) => {
    handleWsMessage(event.data).catch((error) => {
      console.error(`[atoms3r-bridge] message handling failed: ${error.message}`);
    });
  });

  ws.addEventListener('error', (event) => {
    const message = event?.message ?? 'websocket error';
    console.error(`[atoms3r-bridge] ${message}`);
  });

  ws.addEventListener('close', () => {
    console.error('[atoms3r-bridge] face-app websocket closed; reconnecting');
    reconnectTimer = setTimeout(connect, 1000);
  });
}

async function handleWsMessage(data) {
  const text = await dataToString(data);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!payload || typeof payload.type !== 'string') {
    return;
  }

  if (payload.type === 'tts_audio_ref') {
    observeGeneration(payload);
    console.log(
      `[atoms3r-bridge] received tts_audio_ref bytes=${Number.isInteger(payload.byte_length) ? payload.byte_length : 'unknown'}`
    );
    await forwardAudioRef(payload);
    return;
  }

  if (!relayTypes.has(payload.type)) {
    return;
  }

  if (payload.type === 'tts_state' && payload.phase === 'worker_ready') {
    resetGenerationWindow('worker_ready');
  }

  if (payload.type === 'tts_mouth' && !shouldForwardMouth(payload)) {
    return;
  }

  if (payload.type === 'tts_state') {
    console.log(`[atoms3r-bridge] received tts_state phase=${payload.phase ?? 'unknown'}`);
  } else if (payload.type === 'tts_audio') {
    observeGeneration(payload);
    await forwardDirectAudio(payload);
    return;
  }

  enqueuePost(payload, payload.type);
}

async function forwardDirectAudio(payload) {
  if (!forwardAudio) {
    return;
  }
  const audioBase64 = typeof payload.audio_base64 === 'string' ? payload.audio_base64 : '';
  console.log(`[atoms3r-bridge] received tts_audio base64=${audioBase64.length}`);
  if (audioBase64.trim() === '') {
    return;
  }

  const audio = Buffer.from(audioBase64, 'base64');
  if (audio.length === 0) {
    console.error('[atoms3r-bridge] skipping tts_audio; decoded audio is empty');
    return;
  }
  if (audio.length + 4096 > maxPayloadBytes) {
    console.error(`[atoms3r-bridge] skipping tts_audio; decoded payload is too large (${audio.length} bytes)`);
    return;
  }

  enqueueAudioPost(audio, payload);
}

async function forwardAudioRef(payload) {
  if (!forwardAudio) {
    return;
  }
  if (!fetchAudioRef) {
    console.log('[atoms3r-bridge] skipping tts_audio_ref fetch; waiting for direct tts_audio');
    return;
  }
  if (typeof payload.url !== 'string' || payload.url.trim() === '') {
    return;
  }

  const advertisedLength = Number.isInteger(payload.byte_length) ? payload.byte_length : null;
  if (advertisedLength !== null && estimatedAudioPayloadBytes(advertisedLength) > maxPayloadBytes) {
    console.error(`[atoms3r-bridge] skipping audio ref; advertised payload is too large (${advertisedLength} bytes)`);
    return;
  }

  const audioUrl = new URL(payload.url, faceHttpBase).toString();
  const headers = {};
  if (faceAuthToken) {
    headers.Authorization = `Bearer ${faceAuthToken}`;
  }

  const response = await fetch(audioUrl, {
    headers,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    console.error(`[atoms3r-bridge] audio fetch failed status=${response.status}`);
    return;
  }

  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isInteger(contentLength) && contentLength > 0 && estimatedAudioPayloadBytes(contentLength) > maxPayloadBytes) {
    console.error(`[atoms3r-bridge] skipping audio ref; fetched payload is too large (${contentLength} bytes)`);
    return;
  }

  const audio = Buffer.from(await response.arrayBuffer());
  if (estimatedAudioPayloadBytes(audio.length) > maxPayloadBytes) {
    console.error(`[atoms3r-bridge] skipping audio ref; fetched payload is too large (${audio.length} bytes)`);
    return;
  }

  const forwarded = {
    ...payload,
    type: 'tts_audio',
    mime_type: typeof payload.mime_type === 'string' ? payload.mime_type : 'audio/wav',
    audio_base64: audio.toString('base64'),
    byte_length: audio.length,
    ts: Date.now()
  };
  delete forwarded.url;
  delete forwarded.expires_at;

  enqueuePost(forwarded, 'tts_audio_ref');
}

function shouldForwardMouth(payload) {
  const open = Number(payload.open);
  if (!Number.isFinite(open)) {
    return false;
  }
  const now = Date.now();
  const isClosed = open <= 0.04;
  if (!isClosed && now - lastMouthForwardedAt < mouthIntervalMs) {
    return false;
  }
  if (lastMouthOpen !== null && Math.abs(open - lastMouthOpen) < 0.02 && now - lastMouthForwardedAt < 250) {
    return false;
  }
  lastMouthForwardedAt = now;
  lastMouthOpen = open;
  return true;
}

function enqueuePost(payload, sourceType) {
  const body = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(body);
  if (byteLength > maxPayloadBytes) {
    console.error(`[atoms3r-bridge] skipping ${sourceType}; payload too large (${byteLength} bytes)`);
    return;
  }

  postChain = postChain
    .catch(() => {})
    .then(async () => {
      try {
        await postPayloadWithDiscovery(body, sourceType, byteLength);
      } catch (error) {
        console.error(`[atoms3r-bridge] ${error.message}`);
      }
    });
}

function enqueueAudioPost(audio, payload) {
  const gen = Number.isInteger(payload?.generation) ? payload.generation : null;
  postChain = postChain
    .catch(() => {})
    .then(async () => {
      // Drop audio superseded by an interrupt: only the current generation's
      // chunks reach the Atom, arriving at their normal play_stop spacing, so
      // the firmware never gets a rapid stop/replay burst.
      if (gen !== null && gen < latestGeneration) {
        console.log(`[atoms3r-bridge] dropping stale tts_audio gen=${gen} < ${latestGeneration} (interrupt)`);
        return;
      }
      try {
        await postAudioWithDiscovery(audio, payload);
      } catch (error) {
        console.error(`[atoms3r-bridge] ${error.message}`);
      }
    });
}

async function postPayloadWithDiscovery(body, sourceType, byteLength) {
  try {
    await postPayload(body, sourceType, byteLength);
  } catch (error) {
    if (!(await recoverAtomAfterPostFailure(error, sourceType))) {
      throw error;
    }
    await postPayload(body, sourceType, byteLength);
  }
}

async function postAudioWithDiscovery(audio, payload) {
  try {
    await postAudio(audio, payload);
  } catch (error) {
    if (!(await recoverAtomAfterPostFailure(error, 'tts_audio'))) {
      throw error;
    }
    await postAudio(audio, payload);
  }
}

async function recoverAtomAfterPostFailure(error, sourceType) {
  if (!discoveryEnabled) {
    return false;
  }
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && error.status !== 404) {
    return false;
  }
  console.error(`[atoms3r-bridge] ${sourceType} POST failed via ${redactUrl(atomBaseUrl)}; discovering Atom (${error.message})`);
  return ensureAtomReachable(`post_failure:${sourceType}`);
}

async function postPayload(body, sourceType, byteLength) {
  const headers = {
    'content-type': 'application/json'
  };
  if (atomAuthToken) {
    headers['x-headroom-auth'] = atomAuthToken;
  }

  const response = await fetch(atomPayloadUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    const error = new Error(`Atom POST failed type=${sourceType} status=${response.status} body=${responseText.slice(0, 120)}`);
    error.status = response.status;
    throw error;
  }

  if (sourceType !== 'tts_mouth') {
    console.log(`[atoms3r-bridge] forwarded ${sourceType} (${byteLength} bytes)`);
  }
}

async function postAudio(audio, payload) {
  const headers = {
    'content-type': typeof payload.mime_type === 'string' && payload.mime_type.trim() !== '' ? payload.mime_type : 'audio/wav'
  };
  if (atomAuthToken) {
    headers['x-headroom-auth'] = atomAuthToken;
  }
  if (typeof payload.utterance_id === 'string') {
    headers['x-utterance-id'] = payload.utterance_id;
  }
  if (Number.isInteger(payload.generation)) {
    headers['x-generation'] = String(payload.generation);
  }

  const response = await fetch(atomAudioUrl, {
    method: 'POST',
    headers,
    body: audio,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    const error = new Error(`Atom audio POST failed status=${response.status} body=${responseText.slice(0, 120)}`);
    error.status = response.status;
    throw error;
  }
  console.log(`[atoms3r-bridge] forwarded tts_audio wav (${audio.length} bytes)`);
}

async function checkAtomHealth() {
  const headers = {};
  if (atomAuthToken) {
    headers['x-headroom-auth'] = atomAuthToken;
  }
  try {
    const response = await fetch(atomHealthUrl, {
      headers,
      signal: AbortSignal.timeout(3000)
    });
    if (!response.ok) {
      console.error(`[atoms3r-bridge] Atom health status=${response.status}; continuing`);
      return false;
    }
    const health = await response.json().catch(() => null);
    if (!isAtomHealthPayload(health)) {
      console.error('[atoms3r-bridge] Atom health response did not identify atoms3r-headroom');
      return false;
    }
    console.log(`[atoms3r-bridge] Atom health ok (${health.ip ?? redactUrl(atomBaseUrl)})`);
    return true;
  } catch (error) {
    console.error(`[atoms3r-bridge] Atom health check failed: ${error.message}; continuing`);
    return false;
  }
}

async function ensureAtomReachable(reason) {
  if (await checkAtomHealth()) {
    return true;
  }
  if (!discoveryEnabled) {
    return false;
  }
  const discovered = await discoverAtom(reason);
  if (!discovered) {
    return false;
  }
  setAtomBaseUrl(discovered, `discovery:${reason}`);
  return checkAtomHealth();
}

async function discoverAtom(reason) {
  const candidates = discoverCandidateUrls();
  if (candidates.length === 0) {
    console.error('[atoms3r-bridge] no Atom discovery candidates found');
    return null;
  }

  console.log(`[atoms3r-bridge] discovering Atom (${reason}); candidates=${candidates.length}`);
  let index = 0;
  let found = null;

  async function worker() {
    while (!found && index < candidates.length) {
      const candidate = candidates[index++];
      const health = await probeAtomHealth(candidate);
      if (health) {
        found = candidate;
        const label = health.device_id ? `${health.device_id} ` : '';
        console.log(`[atoms3r-bridge] discovered Atom ${label}at ${redactUrl(candidate)}`);
        return;
      }
    }
  }

  const workers = [];
  const count = Math.min(discoveryConcurrency, candidates.length);
  for (let i = 0; i < count; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  if (!found) {
    console.error('[atoms3r-bridge] Atom discovery found no matching /health endpoint');
  }
  return found;
}

async function probeAtomHealth(baseUrl) {
  const headers = {};
  if (atomAuthToken) {
    headers['x-headroom-auth'] = atomAuthToken;
  }
  try {
    const response = await fetch(new URL('/health', baseUrl).toString(), {
      headers,
      signal: AbortSignal.timeout(discoveryTimeoutMs)
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json().catch(() => null);
    return isAtomHealthPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isAtomHealthPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.ok !== true || payload.service !== 'atoms3r-headroom') {
    return false;
  }
  if (expectedDeviceId && payload.device_id !== expectedDeviceId) {
    return false;
  }
  return true;
}

function discoverCandidateUrls() {
  const urls = new Set();
  urls.add(atomBaseUrl);
  urls.add(configuredAtomBaseUrl);

  for (const info of Object.values(networkInterfaces()).flat()) {
    if (!info || info.family !== 'IPv4' || info.internal) {
      continue;
    }
    const octets = info.address.split('.').map((part) => Number.parseInt(part, 10));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      continue;
    }
    const prefix = `${octets[0]}.${octets[1]}.${octets[2]}`;
    for (let host = 1; host <= 254; host += 1) {
      const address = `${prefix}.${host}`;
      if (address === info.address) {
        continue;
      }
      urls.add(`http://${address}/`);
    }
  }

  // Routed subnets the PC can reach but isn't locally attached to (e.g. a travel
  // router's LAN over a Tailscale subnet route). These don't appear in
  // networkInterfaces(), so add them explicitly.
  for (const prefix of discoverySubnets) {
    for (let host = 1; host <= 254; host += 1) {
      urls.add(`http://${prefix}.${host}/`);
    }
  }

  return [...urls];
}

// Parse ATOM_HEADROOM_DISCOVERY_SUBNETS into a list of "a.b.c" /24 prefixes.
// Accepts "a.b.c.0/24" or a bare "a.b.c" prefix, comma/space separated. Only
// /24 is supported — a single /24 sweep is 254 probes, and wider masks are
// impractical to brute-force.
function parseDiscoverySubnets(value) {
  const out = [];
  if (!value) {
    return out;
  }
  for (const raw of String(value).split(/[,\s]+/)) {
    const entry = raw.trim();
    if (!entry) {
      continue;
    }
    const match = entry.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\.\d{1,3})?(?:\/(\d{1,2}))?$/);
    if (!match) {
      console.error(`[atoms3r-bridge] ignoring invalid ATOM_HEADROOM_DISCOVERY_SUBNETS entry: ${entry}`);
      continue;
    }
    const octets = [match[1], match[2], match[3]].map((part) => Number.parseInt(part, 10));
    if (octets.some((part) => part < 0 || part > 255)) {
      console.error(`[atoms3r-bridge] ignoring out-of-range discovery subnet: ${entry}`);
      continue;
    }
    if (match[4] !== undefined && Number.parseInt(match[4], 10) !== 24) {
      console.error(`[atoms3r-bridge] only /24 discovery subnets are supported; ignoring: ${entry}`);
      continue;
    }
    out.push(`${octets[0]}.${octets[1]}.${octets[2]}`);
  }
  return out;
}

function refreshAtomUrls() {
  atomPayloadUrl = new URL('/api/headroom/payload', atomBaseUrl).toString();
  atomAudioUrl = new URL('/api/headroom/audio', atomBaseUrl).toString();
  atomHealthUrl = new URL('/health', atomBaseUrl).toString();
}

function setAtomBaseUrl(value, reason) {
  const normalized = normalizeBaseUrl(value);
  if (normalized === atomBaseUrl) {
    return;
  }
  console.log(`[atoms3r-bridge] Atom URL changed (${reason}): ${redactUrl(atomBaseUrl)} -> ${redactUrl(normalized)}`);
  atomBaseUrl = normalized;
  refreshAtomUrls();
}

async function dataToString(data) {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (data && typeof data.text === 'function') {
    return data.text();
  }
  return String(data ?? '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeOptionalString(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function estimatedAudioPayloadBytes(audioBytes) {
  return Math.ceil((audioBytes * 4) / 3) + 16384;
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/+$/, '/');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function tokenFromUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.get('auth_token') ?? parsed.searchParams.get('token');
  } catch {
    return null;
  }
}

function readLocalHeadroomToken() {
  const candidates = [
    join(process.cwd(), 'firmware/atoms3r-headroom/include/headroom_config.local.h'),
    join(new URL('..', import.meta.url).pathname, 'firmware/atoms3r-headroom/include/headroom_config.local.h')
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const match = text.match(/^\s*#define\s+HEADROOM_AUTH_TOKEN\s+"([^"]+)"/m);
      if (match?.[1]) {
        return match[1];
      }
    } catch {}
  }
  return null;
}

function withAuthQuery(value, token) {
  if (!token) {
    return value;
  }
  const parsed = new URL(value);
  if (!parsed.searchParams.has('auth_token') && !parsed.searchParams.has('token')) {
    parsed.searchParams.set('auth_token', token);
  }
  return parsed.toString();
}

function httpBaseFromWsUrl(value) {
  const parsed = new URL(value);
  parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function redactUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has('auth_token')) {
      parsed.searchParams.set('auth_token', '<redacted>');
    }
    if (parsed.searchParams.has('token')) {
      parsed.searchParams.set('token', '<redacted>');
    }
    return parsed.toString();
  } catch {
    return value;
  }
}
