import { spawn } from 'node:child_process';

export const MP3_AUDIO_CODEC = 'mp3';
export const MP3_MIME_TYPE = 'audio/mpeg';
export const MP3_NOMINAL_BITRATE = 128_000;

const DEFAULT_COMMAND = 'ffmpeg';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function assertPcmWav(buffer, maxInputBytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('MP3 encoder requires a non-empty WAV buffer');
  }
  if (buffer.length > maxInputBytes) {
    throw new Error(`MP3 encoder input exceeds ${maxInputBytes} bytes`);
  }
  if (
    buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('MP3 encoder input is not a RIFF/WAVE file');
  }
}

export function ffmpegMp3Args() {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-f', 'wav',
    '-i', 'pipe:0',
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-write_xing', '0',
    '-id3v2_version', '0',
    '-flush_packets', '1',
    '-f', 'mp3',
    'pipe:1'
  ];
}

export function containsMp3Frame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }
  const scanLength = Math.min(buffer.length - 1, 4_096);
  for (let index = 0; index < scanLength; index += 1) {
    if (buffer[index] !== 0xff || (buffer[index + 1] & 0xe0) !== 0xe0) {
      continue;
    }
    const versionBits = (buffer[index + 1] >> 3) & 0x03;
    const layerBits = (buffer[index + 1] >> 1) & 0x03;
    if (versionBits !== 0x01 && layerBits !== 0x00) {
      return true;
    }
  }
  return false;
}

export async function encodePcm16WavToMp3(wavBuffer, options = {}) {
  const command = typeof options.command === 'string' && options.command.trim() !== ''
    ? options.command.trim()
    : DEFAULT_COMMAND;
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxInputBytes = positiveInteger(options.maxInputBytes, DEFAULT_MAX_INPUT_BYTES);
  const maxOutputBytes = positiveInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxStderrBytes = positiveInteger(options.maxStderrBytes, DEFAULT_MAX_STDERR_BYTES);
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn;
  const signal = options.signal;
  const input = Buffer.from(wavBuffer);
  assertPcmWav(input, maxInputBytes);
  if (signal?.aborted) {
    return Promise.reject(new Error('MP3 encoder was aborted'));
  }
  const args = ffmpegMp3Args();

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      reject(new Error(`MP3 encoder could not start: ${error.message}`));
      return;
    }

    const outputChunks = [];
    const stderrChunks = [];
    let outputBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let closed = false;
    let timer = null;
    let abortHandler = null;

    const finish = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      if (abortHandler && typeof signal?.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortHandler);
      }
      handler(value);
    };

    const fail = (error, { terminate = false } = {}) => {
      if (terminate && !closed) {
        try {
          child.kill('SIGKILL');
        } catch {}
      }
      finish(reject, error);
    };

    timer = setTimeout(() => {
      fail(new Error(`MP3 encoder timed out after ${timeoutMs} ms`), { terminate: true });
    }, timeoutMs);
    abortHandler = () => {
      fail(new Error('MP3 encoder was aborted'), { terminate: true });
    };
    signal?.addEventListener?.('abort', abortHandler, { once: true });

    child.stdout.on('data', (chunk) => {
      const copy = Buffer.from(chunk);
      outputBytes += copy.length;
      if (outputBytes > maxOutputBytes) {
        fail(new Error(`MP3 encoder output exceeds ${maxOutputBytes} bytes`), { terminate: true });
        return;
      }
      outputChunks.push(copy);
    });

    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maxStderrBytes) {
        return;
      }
      const copy = Buffer.from(chunk);
      const remaining = maxStderrBytes - stderrBytes;
      const bounded = copy.length > remaining ? copy.subarray(0, remaining) : copy;
      stderrBytes += bounded.length;
      stderrChunks.push(bounded);
    });

    child.stdout.on('error', (error) => {
      fail(new Error(`MP3 encoder stdout failed: ${error.message}`), { terminate: true });
    });
    child.stderr.on('error', (error) => {
      fail(new Error(`MP3 encoder stderr failed: ${error.message}`), { terminate: true });
    });
    child.stdin.on('error', (error) => {
      fail(new Error(`MP3 encoder stdin failed: ${error.message}`), { terminate: true });
    });
    child.on('error', (error) => {
      fail(new Error(`MP3 encoder process failed: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      closed = true;
      if (settled) {
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      if (code !== 0) {
        const suffix = stderr === '' ? '' : `: ${stderr}`;
        fail(new Error(`MP3 encoder exited with ${code ?? signal ?? 'unknown'}${suffix}`));
        return;
      }
      const buffer = Buffer.concat(outputChunks, outputBytes);
      if (!containsMp3Frame(buffer)) {
        fail(new Error('MP3 encoder returned no valid MPEG audio frame'));
        return;
      }
      finish(resolve, {
        buffer,
        codec: MP3_AUDIO_CODEC,
        mimeType: MP3_MIME_TYPE,
        bitrate: MP3_NOMINAL_BITRATE,
        inputBytes: input.length,
        outputBytes: buffer.length
      });
    });

    try {
      child.stdin.end(input);
    } catch (error) {
      fail(new Error(`MP3 encoder input failed: ${error.message}`), { terminate: true });
    }
  });
}
