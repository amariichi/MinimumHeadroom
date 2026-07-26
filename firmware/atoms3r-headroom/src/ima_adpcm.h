#pragma once

#include <stddef.h>
#include <stdint.h>

// IMA ADPCM 4:1 compression for 16-bit PCM audio frames.
//
// The encoder produces a 4-byte block header followed by 4-bit samples
// packed two-per-byte. The header carries the 16-bit predictor and the
// 8-bit step index at the start of the block (plus one reserved byte)
// so a receiver does NOT need to chain state across blocks — each frame
// is independently decodable. This costs 4 bytes per frame; at 1024
// samples per frame the per-frame overhead is < 1%.
//
// Output buffer must be at least ima_adpcm_encoded_size(sampleCount)
// bytes. The first sample is stored in the block header; the remaining
// samples are packed as nibbles, with an odd final nibble padded in its byte.
// Returns the number of bytes written.
//
// Algorithm reference: IMA Digital Audio Focus and Technical Working
// Groups, "Recommended Practices for Enhancing Digital Audio
// Compatibility in Multimedia Systems", Rev 3.00 (1992). The step and
// index tables in the .cpp are the canonical ones.

#ifdef __cplusplus
extern "C" {
#endif

// Required output buffer size in bytes for an input PCM buffer of
// `sampleCount` 16-bit samples. Reserves 4 bytes for the block header
// plus one nibble for each sample after the predictor.
inline size_t ima_adpcm_encoded_size(size_t sampleCount) {
  return sampleCount == 0 ? 0 : 4 + sampleCount / 2;
}

// Encode `sampleCount` 16-bit PCM samples into IMA ADPCM 4-bit nibbles.
// `dst` must point at a buffer of at least ima_adpcm_encoded_size(sampleCount)
// bytes. Returns the number of bytes actually written.
size_t ima_adpcm_encode(const int16_t* src, size_t sampleCount, uint8_t* dst);

// Maximum PCM samples represented by one independent IMA block, including
// the predictor stored in its four-byte header.
inline size_t ima_adpcm_decoded_sample_capacity(size_t encodedBytes) {
  return encodedBytes < 4 ? 0 : 1 + ((encodedBytes - 4) * 2);
}

// Decode one independent IMA block. `maxSamples` may trim padding from a full
// WAV block. Returns the number of samples written, or 0 for an invalid block.
size_t ima_adpcm_decode(const uint8_t* src, size_t encodedBytes, int16_t* dst, size_t maxSamples);

#ifdef __cplusplus
}
#endif
