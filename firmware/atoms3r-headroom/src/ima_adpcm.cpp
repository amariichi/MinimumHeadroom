#include "ima_adpcm.h"

namespace {

// Canonical IMA ADPCM step-size table (89 entries).
constexpr int kStepTable[89] = {
    7,     8,     9,     10,    11,    12,    13,    14,    16,    17,
    19,    21,    23,    25,    28,    31,    34,    37,    41,    45,
    50,    55,    60,    66,    73,    80,    88,    97,    107,   118,
    130,   143,   157,   173,   190,   209,   230,   253,   279,   307,
    337,   371,   408,   449,   494,   544,   598,   658,   724,   796,
    876,   963,   1060,  1166,  1282,  1411,  1552,  1707,  1878,  2066,
    2272,  2499,  2749,  3024,  3327,  3660,  4026,  4428,  4871,  5358,
    5894,  6484,  7132,  7845,  8630,  9493,  10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
};

// Canonical IMA ADPCM index adjustment table.
constexpr int kIndexTable[16] = {
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
};

inline int clampStepIndex(int index) {
  if (index < 0) return 0;
  if (index > 88) return 88;
  return index;
}

inline int clampPredictor(int sample) {
  if (sample > 32767) return 32767;
  if (sample < -32768) return -32768;
  return sample;
}

uint8_t encodeSample(int sample, int& predictor, int& stepIndex) {
  int step = kStepTable[stepIndex];
  int diff = sample - predictor;
  uint8_t code = 0;
  if (diff < 0) {
    code = 0x8;
    diff = -diff;
  }
  // Encode magnitude into 3 bits with the standard reconstruction rule.
  int mag = step;
  if (diff >= step) {
    code |= 0x4;
    diff -= step;
  }
  step >>= 1;
  if (diff >= step) {
    code |= 0x2;
    diff -= step;
  }
  step >>= 1;
  if (diff >= step) {
    code |= 0x1;
  }

  // Reproduce what the decoder will reconstruct so the next prediction
  // tracks the cumulative error correctly.
  int delta = kStepTable[stepIndex] >> 3;
  if (code & 0x1) delta += kStepTable[stepIndex] >> 2;
  if (code & 0x2) delta += kStepTable[stepIndex] >> 1;
  if (code & 0x4) delta += kStepTable[stepIndex];
  if (code & 0x8) {
    predictor -= delta;
  } else {
    predictor += delta;
  }
  predictor = clampPredictor(predictor);

  stepIndex = clampStepIndex(stepIndex + kIndexTable[code]);
  (void)mag;
  return code & 0x0f;
}

}  // namespace

size_t ima_adpcm_encode(const int16_t* src, size_t sampleCount, uint8_t* dst) {
  if (sampleCount == 0) {
    return 0;
  }
  // Block header: initial predictor (LE int16) | step index (uint8) | reserved (uint8).
  int predictor = src[0];
  int stepIndex = 0;

  // Write the block header. The decoder uses the initial predictor as
  // the "previous reconstructed sample" and seeds its step index from
  // the same byte; the reserved byte is for alignment / future tags.
  dst[0] = static_cast<uint8_t>(predictor & 0xff);
  dst[1] = static_cast<uint8_t>((predictor >> 8) & 0xff);
  dst[2] = static_cast<uint8_t>(stepIndex & 0xff);
  dst[3] = 0;
  size_t outIdx = 4;

  // The first sample is implicit in the header — no nibble emitted for
  // it. Remaining samples produce one nibble each; pack low nibble first
  // (matches Microsoft IMA / WAV nibble order) and emit when paired.
  uint8_t pendingByte = 0;
  bool hasPending = false;
  for (size_t i = 1; i < sampleCount; ++i) {
    uint8_t nibble = encodeSample(src[i], predictor, stepIndex);
    if (!hasPending) {
      pendingByte = nibble;
      hasPending = true;
    } else {
      pendingByte |= static_cast<uint8_t>(nibble << 4);
      dst[outIdx++] = pendingByte;
      hasPending = false;
    }
  }
  if (hasPending) {
    dst[outIdx++] = pendingByte;
  }
  return outIdx;
}
