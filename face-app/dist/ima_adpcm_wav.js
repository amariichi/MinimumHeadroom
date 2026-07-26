const MIN_SAMPLE_RATE = 8_000;
const MAX_SAMPLE_RATE = 48_000;
const DEFAULT_BLOCK_ALIGN = 512;

const IMA_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
  19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
  876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
  2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
  5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
  15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
];

const IMA_INDEX_TABLE = [
  -1, -1, -1, -1, 2, 4, 6, 8,
  -1, -1, -1, -1, 2, 4, 6, 8
];

function fail(message) {
  throw new Error(`invalid WAV: ${message}`);
}

function clampInt16(value) {
  return Math.max(-32_768, Math.min(32_767, value));
}

function clampStepIndex(value) {
  return Math.max(0, Math.min(88, value));
}

function parseRiffChunks(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    fail('header is missing');
  }
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    fail('RIFF/WAVE signature is missing');
  }

  const riffEnd = buffer.readUInt32LE(4) + 8;
  if (riffEnd < 12 || riffEnd > buffer.length) {
    fail('RIFF length is out of bounds');
  }

  let fmt = null;
  let factSampleCount = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= riffEnd) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > riffEnd) {
      fail(`chunk ${id} exceeds RIFF length`);
    }

    if (id === 'fmt ' && fmt === null) {
      if (size < 16) {
        fail('fmt chunk is too short');
      }
      fmt = {
        size,
        formatTag: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
        extraSize: size >= 18 ? buffer.readUInt16LE(start + 16) : 0,
        samplesPerBlock: size >= 20 ? buffer.readUInt16LE(start + 18) : null
      };
    } else if (id === 'fact' && size >= 4 && factSampleCount === null) {
      factSampleCount = buffer.readUInt32LE(start);
    } else if (id === 'data' && data === null) {
      data = {
        offset: start,
        byteLength: size
      };
    }

    offset = end + (size & 1);
  }

  if (!fmt || !data) {
    fail('fmt or data chunk is missing');
  }
  if (fmt.sampleRate < MIN_SAMPLE_RATE || fmt.sampleRate > MAX_SAMPLE_RATE) {
    fail(`sample rate ${fmt.sampleRate} is unsupported`);
  }
  if (data.byteLength === 0) {
    fail('data chunk is empty');
  }
  return { fmt, factSampleCount, data };
}

export function parsePcm16MonoWav(buffer) {
  const parsed = parseRiffChunks(buffer);
  const { fmt, data } = parsed;
  if (
    fmt.formatTag !== 1
    || fmt.channels !== 1
    || fmt.bitsPerSample !== 16
    || fmt.blockAlign !== 2
    || fmt.byteRate !== fmt.sampleRate * 2
  ) {
    fail('expected mono PCM16');
  }
  if ((data.byteLength & 1) !== 0) {
    fail('PCM data has a partial sample');
  }
  return {
    sampleRate: fmt.sampleRate,
    sampleCount: data.byteLength / 2,
    pcm: buffer.subarray(data.offset, data.offset + data.byteLength)
  };
}

function encodeNibble(sample, state) {
  const step = IMA_STEP_TABLE[state.stepIndex];
  let difference = sample - state.predictor;
  let code = 0;
  if (difference < 0) {
    code = 8;
    difference = -difference;
  }
  if (difference >= step) {
    code |= 4;
    difference -= step;
  }
  if (difference >= (step >> 1)) {
    code |= 2;
    difference -= step >> 1;
  }
  if (difference >= (step >> 2)) {
    code |= 1;
  }

  let delta = step >> 3;
  if ((code & 1) !== 0) delta += step >> 2;
  if ((code & 2) !== 0) delta += step >> 1;
  if ((code & 4) !== 0) delta += step;
  state.predictor = clampInt16(state.predictor + ((code & 8) !== 0 ? -delta : delta));
  state.stepIndex = clampStepIndex(state.stepIndex + IMA_INDEX_TABLE[code]);
  return code;
}

function decodeNibble(code, state) {
  const step = IMA_STEP_TABLE[state.stepIndex];
  let delta = step >> 3;
  if ((code & 1) !== 0) delta += step >> 2;
  if ((code & 2) !== 0) delta += step >> 1;
  if ((code & 4) !== 0) delta += step;
  state.predictor = clampInt16(state.predictor + ((code & 8) !== 0 ? -delta : delta));
  state.stepIndex = clampStepIndex(state.stepIndex + IMA_INDEX_TABLE[code & 0x0f]);
  return state.predictor;
}

export function encodePcm16WavToImaAdpcmWav(
  input,
  { blockAlign = DEFAULT_BLOCK_ALIGN } = {}
) {
  const { sampleRate, sampleCount, pcm } = parsePcm16MonoWav(input);
  if (!Number.isInteger(blockAlign) || blockAlign < 8 || blockAlign > 65_535) {
    throw new Error('IMA ADPCM blockAlign must be an integer from 8 to 65535');
  }

  const samplesPerBlock = ((blockAlign - 4) * 2) + 1;
  if (samplesPerBlock > 65_535) {
    throw new Error('IMA ADPCM samplesPerBlock exceeds WAV limits');
  }
  const blockCount = Math.ceil(sampleCount / samplesPerBlock);
  const dataBytes = blockCount * blockAlign;
  const output = Buffer.alloc(60 + dataBytes);

  output.write('RIFF', 0, 4, 'ascii');
  output.writeUInt32LE(output.length - 8, 4);
  output.write('WAVE', 8, 4, 'ascii');

  output.write('fmt ', 12, 4, 'ascii');
  output.writeUInt32LE(20, 16);
  output.writeUInt16LE(0x0011, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(Math.floor((sampleRate * blockAlign) / samplesPerBlock), 28);
  output.writeUInt16LE(blockAlign, 32);
  output.writeUInt16LE(4, 34);
  output.writeUInt16LE(2, 36);
  output.writeUInt16LE(samplesPerBlock, 38);

  output.write('fact', 40, 4, 'ascii');
  output.writeUInt32LE(4, 44);
  output.writeUInt32LE(sampleCount, 48);
  output.write('data', 52, 4, 'ascii');
  output.writeUInt32LE(dataBytes, 56);

  let carriedStepIndex = 0;
  let sourceIndex = 0;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const blockOffset = 60 + (blockIndex * blockAlign);
    const samplesThisBlock = Math.min(samplesPerBlock, sampleCount - sourceIndex);
    const predictor = pcm.readInt16LE(sourceIndex * 2);
    const state = {
      predictor,
      stepIndex: carriedStepIndex
    };
    output.writeInt16LE(predictor, blockOffset);
    output.writeUInt8(state.stepIndex, blockOffset + 2);
    output.writeUInt8(0, blockOffset + 3);

    const lastSample = pcm.readInt16LE((sourceIndex + samplesThisBlock - 1) * 2);
    let packed = 0;
    let dataOffset = blockOffset + 4;
    for (let sampleInBlock = 1; sampleInBlock < samplesPerBlock; sampleInBlock += 1) {
      const sample = sampleInBlock < samplesThisBlock
        ? pcm.readInt16LE((sourceIndex + sampleInBlock) * 2)
        : lastSample;
      const code = encodeNibble(sample, state);
      if ((sampleInBlock & 1) === 1) {
        packed = code;
      } else {
        output[dataOffset] = packed | (code << 4);
        dataOffset += 1;
      }
    }
    carriedStepIndex = state.stepIndex;
    sourceIndex += samplesThisBlock;
  }

  return {
    buffer: output,
    codec: 'ima_adpcm_wav',
    sampleRate,
    sampleCount,
    blockAlign,
    samplesPerBlock
  };
}

export function decodeImaAdpcmWav(buffer) {
  const parsed = parseRiffChunks(buffer);
  const { fmt, data, factSampleCount } = parsed;
  if (
    fmt.formatTag !== 0x0011
    || fmt.channels !== 1
    || fmt.bitsPerSample !== 4
    || fmt.size < 20
    || fmt.extraSize < 2
    || !Number.isInteger(fmt.samplesPerBlock)
    || fmt.samplesPerBlock < 2
    || fmt.blockAlign < 5
  ) {
    fail('expected mono IMA ADPCM');
  }

  const expectedSamplesPerBlock = ((fmt.blockAlign - 4) * 2) + 1;
  if (fmt.samplesPerBlock !== expectedSamplesPerBlock) {
    fail('IMA samplesPerBlock does not match blockAlign');
  }
  if (data.byteLength % fmt.blockAlign !== 0) {
    fail('IMA data contains a partial block');
  }

  const blockCount = data.byteLength / fmt.blockAlign;
  const maximumSamples = blockCount * fmt.samplesPerBlock;
  if (
    !Number.isInteger(factSampleCount)
    || factSampleCount <= (blockCount - 1) * fmt.samplesPerBlock
    || factSampleCount > maximumSamples
  ) {
    fail('IMA fact sample count is missing or inconsistent');
  }

  const pcm = Buffer.alloc(factSampleCount * 2);
  let outputIndex = 0;
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    const blockOffset = data.offset + (blockIndex * fmt.blockAlign);
    const stepIndex = buffer.readUInt8(blockOffset + 2);
    const reserved = buffer.readUInt8(blockOffset + 3);
    if (stepIndex > 88 || reserved !== 0) {
      fail('IMA block header is invalid');
    }
    const state = {
      predictor: buffer.readInt16LE(blockOffset),
      stepIndex
    };
    if (outputIndex < factSampleCount) {
      pcm.writeInt16LE(state.predictor, outputIndex * 2);
      outputIndex += 1;
    }

    for (let byteIndex = 4; byteIndex < fmt.blockAlign && outputIndex < factSampleCount; byteIndex += 1) {
      const packed = buffer[blockOffset + byteIndex];
      pcm.writeInt16LE(decodeNibble(packed & 0x0f, state), outputIndex * 2);
      outputIndex += 1;
      if (outputIndex < factSampleCount) {
        pcm.writeInt16LE(decodeNibble((packed >> 4) & 0x0f, state), outputIndex * 2);
        outputIndex += 1;
      }
    }
  }

  if (outputIndex !== factSampleCount) {
    fail('IMA data ended before fact sample count');
  }
  return {
    pcm,
    sampleRate: fmt.sampleRate,
    sampleCount: factSampleCount,
    blockAlign: fmt.blockAlign,
    samplesPerBlock: fmt.samplesPerBlock
  };
}

export const IMA_ADPCM_WAV_CODEC = 'ima_adpcm_wav';
export const PCM16_WAV_CODEC = 'pcm16_wav';
