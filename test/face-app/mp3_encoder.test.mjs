import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  containsMp3Frame,
  encodePcm16WavToMp3,
  ffmpegMp3Args
} from '../../face-app/dist/mp3_encoder.js';

function wavFixture({ sampleRate = 24_000, sampleCount = 2 } = {}) {
  const wav = Buffer.alloc(44 + (sampleCount * 2));
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    wav.writeInt16LE(
      Math.round(4_000 * Math.sin(2 * Math.PI * 220 * index / sampleRate)),
      44 + (index * 2)
    );
  }
  return wav;
}

function spawnFixture({ output = Buffer.from([0xff, 0xfb, 0x90, 0x64]), code = 0, stderr = '' } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    };
    child.stdin.on('finish', () => {
      child.stdout.end(output);
      child.stderr.end(stderr);
      queueMicrotask(() => child.emit('close', code, null));
    });
    return child;
  };
}

test('FFmpeg MP3 arguments match the working 128 kbit/s Music Player contract', () => {
  const args = ffmpegMp3Args();
  assert.deepEqual(args.slice(-16), [
    '-map', '0:a:0',
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    '-write_xing', '0',
    '-id3v2_version', '0',
    '-flush_packets', '1',
    '-f', 'mp3',
    'pipe:1'
  ]);
});

test('MP3 encoder returns bounded fixed-policy metadata', async () => {
  const result = await encodePcm16WavToMp3(wavFixture(), {
    spawnImpl: spawnFixture()
  });
  assert.equal(result.codec, 'mp3');
  assert.equal(result.mimeType, 'audio/mpeg');
  assert.equal(result.bitrate, 128_000);
  assert.equal(result.inputBytes, 48);
  assert.equal(result.outputBytes, 4);
  assert.equal(containsMp3Frame(result.buffer), true);
});

test('MP3 encoder rejects invalid output and nonzero FFmpeg exits', async () => {
  await assert.rejects(
    encodePcm16WavToMp3(wavFixture(), {
      spawnImpl: spawnFixture({ output: Buffer.from('not-mp3') })
    }),
    /no valid MPEG audio frame/
  );
  await assert.rejects(
    encodePcm16WavToMp3(wavFixture(), {
      spawnImpl: spawnFixture({ code: 1, stderr: 'encoder failed' })
    }),
    /encoder failed/
  );
});

test('MP3 encoder rejects oversized and non-WAV inputs before spawning', async () => {
  await assert.rejects(
    encodePcm16WavToMp3(Buffer.alloc(44), {
      maxInputBytes: 43,
      spawnImpl: () => {
        throw new Error('must not spawn');
      }
    }),
    /exceeds/
  );
  await assert.rejects(
    encodePcm16WavToMp3(Buffer.alloc(44), {
      spawnImpl: () => {
        throw new Error('must not spawn');
      }
    }),
    /RIFF\/WAVE/
  );
});

const ffmpegProbe = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], {
  encoding: 'utf8'
});
const ffprobeProbe = spawnSync('ffprobe', ['-version'], {
  encoding: 'utf8'
});
const hasRealMp3Encoder =
  ffmpegProbe.status === 0
  && /libmp3lame/.test(ffmpegProbe.stdout)
  && ffprobeProbe.status === 0;

test('installed FFmpeg produces a decodable MP3 smaller than Base64 PCM', {
  skip: !hasRealMp3Encoder
}, async () => {
  const wav = wavFixture({ sampleCount: 24_000 });
  const result = await encodePcm16WavToMp3(wav);
  assert.equal(containsMp3Frame(result.buffer), true);
  assert.ok(result.buffer.length < Math.ceil(wav.length / 3) * 4);
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,channels,bit_rate',
    '-of', 'json',
    'pipe:0'
  ], {
    input: result.buffer,
    encoding: 'utf8'
  });
  assert.equal(probe.status, 0, probe.stderr);
  const metadata = JSON.parse(probe.stdout);
  assert.equal(metadata.streams[0].codec_name, 'mp3');
  assert.equal(metadata.streams[0].channels, 1);
  assert.equal(metadata.streams[0].bit_rate, '128000');
});
