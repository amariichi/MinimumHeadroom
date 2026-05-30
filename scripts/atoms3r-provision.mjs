#!/usr/bin/env node
// One-shot AtomS3R provisioning over USB serial.
//
// Plugs into the same RMHCFG line protocol the firmware listens for
// (firmware/atoms3r-headroom/src/headroom_serial_provision.cpp). Pushes up to
// three Wi-Fi networks plus auth token and server URLs into the Atom's NVS so
// the user never has to type them into the Wi-Fi setup portal by hand.
//
// No npm dependency: the tty is configured with `stty raw -echo` and the
// device file is read/written through plain fs streams. The ESP32 USB-CDC
// endpoint ignores the nominal baud; `raw -echo` is what matters.
//
// Token resolution order (matches scripts/run-bound-mcp-server.sh):
//   1. --token <t>
//   2. process.env.MH_FACE_AUTH_TOKEN
//   3. MH_FACE_AUTH_TOKEN= in ${MH_SHARED_ENV_FILE:-$HOME/.config/minimum-headroom.env}
//
// Usage:
//   node scripts/atoms3r-provision.mjs \
//     --wifi "HomeSSID:homepass" --wifi "CafeSSID:cafepass" \
//     --http-base http://192.168.1.10:8765 --ws-url ws://192.168.1.10:8765/ws \
//     --device-id atom-headroom-1 --reboot
//
//   node scripts/atoms3r-provision.mjs --wifi a:b --dry-run    # show payload, no port
//   node scripts/atoms3r-provision.mjs --help

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function usage() {
  console.log(`atoms3r-provision — push Wi-Fi/token/URLs to an AtomS3R over USB serial

Options:
  --port <dev>          serial device (default: /dev/ttyACM0)
  --wifi "SSID:PASS"    Wi-Fi network; repeatable, max 3, in priority order
  --http-base <url>     Face HTTP base URL
  --ws-url <url>        Face WebSocket URL
  --mdns-host <host>    PC mDNS hostname (e.g. my-pc.local) to auto-track the PC's
                        LAN IP at boot; rewrites the host in --ws-url/--http-base.
                        "" clears it (mDNS off). Does not cross subnets — keep the
                        static URLs on a stable off-LAN address (e.g. Tailscale)
  --device-id <id>      device id
  --asr-lang <ja|en>    ASR language used by Atom-originated capture
  --vad-on              enable continuous VAD mode
  --vad-off             disable continuous VAD mode
  --vad-rms <f>         firmware speech threshold (0..1; 0 = send every frame, ~0.025 default,
                        lower for Silero PC backend)
  --vad-encoding <enc>  pcm16 (default, raw 16-bit) or ima_adpcm (4:1 lossy for mobile use)
  --vad-tail <n>        trailing silence frames sent after speech (0..240; ~16 ≈ 1s).
                        Must exceed the PC endSilenceMs/64ms so natural pauses don't
                        chop the utterance; lets vad-rms stay >0 to skip idle silence
  --token <t>           auth token (else env MH_FACE_AUTH_TOKEN, else shared env file)
  --reboot              tell the Atom to reboot after saving
  --dry-run             print the redacted RMHCFG payload and exit (no port access)
  --timeout-ms <n>      reply wait in ms (default: 5000)
  --help                this help
`);
}

function parseArgs(argv) {
  const out = { wifi: [], port: '/dev/ttyACM0', timeoutMs: 5000, reboot: false, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--help' || a === '-h') { out.help = true; }
    else if (a === '--port') out.port = next();
    else if (a === '--wifi') out.wifi.push(next());
    else if (a === '--http-base') out.httpBase = next();
    else if (a === '--ws-url') out.wsUrl = next();
    else if (a === '--mdns-host') out.mdnsHost = next();
    else if (a === '--device-id') out.deviceId = next();
    else if (a === '--asr-lang') out.asrLang = next();
    else if (a === '--vad-on') out.vadOn = true;
    else if (a === '--vad-off') out.vadOn = false;
    else if (a === '--vad-rms') out.vadRms = next();
    else if (a === '--vad-encoding') out.vadEncoding = next();
    else if (a === '--vad-tail') out.vadTail = next();
    else if (a === '--token') out.token = next();
    else if (a === '--reboot') out.reboot = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--timeout-ms') out.timeoutMs = parseInt(next(), 10);
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

function readEnvFileVar(file, name) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === name) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        return v;
      }
    }
  } catch { /* missing file is fine */ }
  return '';
}

function resolveToken(opts) {
  if (opts.token != null) return opts.token;
  if (process.env.MH_FACE_AUTH_TOKEN) return process.env.MH_FACE_AUTH_TOKEN;
  const sharedEnv = process.env.MH_SHARED_ENV_FILE
    || path.join(os.homedir(), '.config/minimum-headroom.env');
  return readEnvFileVar(sharedEnv, 'MH_FACE_AUTH_TOKEN') || '';
}

function buildPayload(opts, token) {
  if (opts.wifi.length > 3) {
    console.error('at most 3 --wifi networks are supported');
    process.exit(2);
  }
  const cfg = {};
  const slots = [['ssid', 'wifi_pw'], ['ssid2', 'wifi_pw2'], ['ssid3', 'wifi_pw3']];
  opts.wifi.forEach((spec, idx) => {
    const sep = spec.indexOf(':');
    if (sep < 0) { console.error(`--wifi must be "SSID:PASSWORD" (got: ${spec})`); process.exit(2); }
    cfg[slots[idx][0]] = spec.slice(0, sep);
    cfg[slots[idx][1]] = spec.slice(sep + 1);
  });
  if (opts.httpBase) cfg.http_base = opts.httpBase;
  if (opts.wsUrl) cfg.ws_url = opts.wsUrl;
  // Allow "" to explicitly clear mdns_host (disable mDNS), so test for !== undefined.
  if (opts.mdnsHost !== undefined) cfg.mdns_host = opts.mdnsHost;
  if (opts.deviceId) cfg.device_id = opts.deviceId;
  if (opts.asrLang) {
    if (!['ja', 'en'].includes(opts.asrLang)) {
      console.error('--asr-lang must be "ja" or "en"');
      process.exit(2);
    }
    cfg.asr_lang = opts.asrLang;
  }
  if (opts.vadOn !== undefined) cfg.vad_on = opts.vadOn;
  if (opts.vadRms !== undefined) {
    const numeric = Number(opts.vadRms);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      console.error('--vad-rms must be a float between 0 and 1 (got: ' + opts.vadRms + ')');
      process.exit(2);
    }
    cfg.vad_rms = numeric;
  }
  if (opts.vadEncoding !== undefined) {
    const enc = String(opts.vadEncoding).trim().toLowerCase();
    if (!['pcm16', 'pcm', 'ima_adpcm', 'adpcm'].includes(enc)) {
      console.error('--vad-encoding must be "pcm16" or "ima_adpcm" (got: ' + opts.vadEncoding + ')');
      process.exit(2);
    }
    cfg.vad_enc = enc === 'pcm' ? 'pcm16' : (enc === 'adpcm' ? 'ima_adpcm' : enc);
  }
  if (opts.vadTail !== undefined) {
    const n = Number(opts.vadTail);
    if (!Number.isInteger(n) || n < 0 || n > 240) {
      console.error('--vad-tail must be an integer between 0 and 240 (got: ' + opts.vadTail + ')');
      process.exit(2);
    }
    cfg.vad_tail = n;
  }
  if (token) cfg.auth = token;
  if (opts.reboot) cfg.reboot = true;
  return cfg;
}

function redact(cfg) {
  const r = { ...cfg };
  for (const k of ['wifi_pw', 'wifi_pw2', 'wifi_pw3', 'auth']) {
    if (r[k] != null) r[k] = `<redacted:${String(r[k]).length}>`;
  }
  return r;
}

async function sendAndWait(port, line, timeoutMs) {
  execFileSync('stty', ['-F', port, '115200', 'raw', '-echo', '-hupcl']);
  const rx = fs.createReadStream(port);
  let buf = '';
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, line: '(timeout: no RMHCFG reply)' }), timeoutMs);
    rx.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const got = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (/^RMHCFG (OK|ERR)/.test(got)) {
          clearTimeout(timer);
          resolve({ ok: got.startsWith('RMHCFG OK'), line: got });
          return;
        }
        if (got.startsWith('RMHCFG STATE')) {
          clearTimeout(timer);
          resolve({ ok: true, line: got });
          return;
        }
      }
    });
    rx.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, line: `(read error: ${e.message})` }); });
    fs.writeFile(port, line, (e) => {
      if (e) { clearTimeout(timer); resolve({ ok: false, line: `(write error: ${e.message})` }); }
    });
  });
  rx.close();
  return result;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { usage(); return; }

  const token = resolveToken(opts);
  if (!token) {
    console.warn('warning: no auth token resolved (--token / MH_FACE_AUTH_TOKEN / shared env file all empty); proceeding without auth');
  }
  const cfg = buildPayload(opts, token);
  if (Object.keys(cfg).length === 0) {
    console.error('nothing to send: pass at least one of --wifi/--http-base/--ws-url/--device-id/--token');
    process.exit(2);
  }
  const payloadLine = `RMHCFG ${JSON.stringify(cfg)}\n`;

  if (opts.dryRun) {
    console.log(`RMHCFG ${JSON.stringify(redact(cfg))}`);
    console.log('(dry-run: port not opened)');
    return;
  }

  console.log(`provisioning ${opts.port} ...`);
  const res = await sendAndWait(opts.port, payloadLine, opts.timeoutMs);
  console.log(`atom: ${res.line}`);
  if (!res.ok) process.exit(1);
  if (opts.reboot) {
    console.log('atom: reboot requested; skipping state read');
    return;
  }

  // Confirm with a redacted state read.
  const state = await sendAndWait(opts.port, 'RMHCFG?\n', opts.timeoutMs);
  console.log(`atom: ${state.line}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
