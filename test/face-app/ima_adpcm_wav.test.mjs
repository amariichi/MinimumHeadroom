import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeImaAdpcmWav,
  encodePcm16WavToImaAdpcmWav,
  parsePcm16MonoWav
} from '../../face-app/dist/ima_adpcm_wav.js';

function pcm16Wav(samples, sampleRate = 44_100) {
  const wav = Buffer.alloc(44 + (samples.length * 2));
  wav.write('RIFF', 0, 4, 'ascii');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVE', 8, 4, 'ascii');
  wav.write('fmt ', 12, 4, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 4, 'ascii');
  wav.writeUInt32LE(samples.length * 2, 40);
  for (let index = 0; index < samples.length; index += 1) {
    wav.writeInt16LE(samples[index], 44 + (index * 2));
  }
  return wav;
}

function speechLikeSamples(sampleRate, seconds) {
  const count = Math.floor(sampleRate * seconds);
  const samples = new Int16Array(count);
  for (let index = 0; index < count; index += 1) {
    const secondsAtSample = index / sampleRate;
    const envelope = Math.min(1, index / 800) * Math.min(1, (count - index) / 800);
    const value = (
      Math.sin(2 * Math.PI * 190 * secondsAtSample) * 7_000
      + Math.sin(2 * Math.PI * 460 * secondsAtSample) * 2_500
      + Math.sin(2 * Math.PI * 1_120 * secondsAtSample) * 900
    ) * envelope;
    samples[index] = Math.round(value);
  }
  return samples;
}

function signalToDistortionDb(reference, decoded) {
  let signal = 0;
  let error = 0;
  for (let index = 0; index < reference.length; index += 1) {
    const expected = reference[index];
    const actual = decoded.readInt16LE(index * 2);
    signal += expected * expected;
    error += (expected - actual) ** 2;
  }
  return 10 * Math.log10(signal / Math.max(1, error));
}

test('standard IMA ADPCM WAV keeps sample rate and compresses PCM below 30 percent', () => {
  const samples = speechLikeSamples(44_100, 3.5);
  const source = pcm16Wav(samples, 44_100);
  const encoded = encodePcm16WavToImaAdpcmWav(source);

  assert.equal(encoded.codec, 'ima_adpcm_wav');
  assert.equal(encoded.sampleRate, 44_100);
  assert.equal(encoded.sampleCount, samples.length);
  assert.equal(encoded.blockAlign, 512);
  assert.equal(encoded.samplesPerBlock, 1017);
  assert.ok(encoded.buffer.length / source.length < 0.30);

  assert.equal(encoded.buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(encoded.buffer.toString('ascii', 8, 12), 'WAVE');
  assert.equal(encoded.buffer.toString('ascii', 12, 16), 'fmt ');
  assert.equal(encoded.buffer.readUInt16LE(20), 0x0011);
  assert.equal(encoded.buffer.readUInt16LE(22), 1);
  assert.equal(encoded.buffer.readUInt32LE(24), 44_100);
  assert.equal(encoded.buffer.readUInt16LE(32), 512);
  assert.equal(encoded.buffer.readUInt16LE(34), 4);
  assert.equal(encoded.buffer.readUInt16LE(38), 1017);
  assert.equal(encoded.buffer.toString('ascii', 40, 44), 'fact');
  assert.equal(encoded.buffer.readUInt32LE(48), samples.length);
  assert.equal(encoded.buffer.toString('ascii', 52, 56), 'data');
  assert.equal(encoded.buffer.readUInt32LE(56) % 512, 0);
});

test('IMA ADPCM WAV roundtrip trims the padded final block using fact samples', () => {
  const samples = speechLikeSamples(24_000, 1.037);
  assert.notEqual(samples.length % 1017, 0);
  const source = pcm16Wav(samples, 24_000);
  const encoded = encodePcm16WavToImaAdpcmWav(source);
  const decoded = decodeImaAdpcmWav(encoded.buffer);

  assert.equal(decoded.sampleRate, 24_000);
  assert.equal(decoded.sampleCount, samples.length);
  assert.equal(decoded.pcm.length, samples.length * 2);
  assert.ok(signalToDistortionDb(samples, decoded.pcm) > 30);
});

test('IMA ADPCM WAV handles a one-sample final stream without exposing padding', () => {
  const source = pcm16Wav(Int16Array.from([1234]), 16_000);
  const encoded = encodePcm16WavToImaAdpcmWav(source);
  const decoded = decodeImaAdpcmWav(encoded.buffer);

  assert.equal(encoded.buffer.length, 60 + 512);
  assert.equal(decoded.sampleCount, 1);
  assert.equal(decoded.pcm.readInt16LE(0), 1234);
});

test('PCM parser and IMA decoder reject incompatible or inconsistent WAV metadata', () => {
  const samples = speechLikeSamples(16_000, 0.2);
  const stereoHeader = pcm16Wav(samples, 16_000);
  stereoHeader.writeUInt16LE(2, 22);
  assert.throws(() => parsePcm16MonoWav(stereoHeader), /expected mono PCM16/);

  const encoded = encodePcm16WavToImaAdpcmWav(pcm16Wav(samples, 16_000)).buffer;
  const invalidFact = Buffer.from(encoded);
  invalidFact.writeUInt32LE(samples.length + 10_000, 48);
  assert.throws(() => decodeImaAdpcmWav(invalidFact), /fact sample count/);

  const invalidIndex = Buffer.from(encoded);
  invalidIndex[62] = 89;
  assert.throws(() => decodeImaAdpcmWav(invalidIndex), /block header/);
});
