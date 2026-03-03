# TTS to ASR Closed-Loop Findings

This directory stores the curated cases and the latest machine-generated report for the Japanese coding-phrase closed-loop harness.

## Bias Notes

- The harness is intentionally biased by the current TTS engine and its pronunciation.
- The generated report is useful for regression detection, not for declaring absolute correctness.
- Final human review is required before promoting any TTS phrasing or ASR normalization change.

## Current Operating Assumptions

- Qwen3 TTS is exercised with `MH_QWEN_TTS_SPEED=1.0` so the report reflects unstretched model output.
- The harness uses `MH_AUDIO_TARGET=browser`, so it captures generated WAV audio directly and bypasses the normal live playback path that may run faster in the app.
- The default loop runs multiple Qwen3 speakers (`Serena`, `Vivian`, `Ono_Anna`) so a normalization tweak is less likely to overfit to one voice.
- The current harness posts to `/v1/asr/{lang}`, so it exercises the batch ASR path (useful for Parakeet fallback validation) rather than the full Voxtral realtime streaming path.
- The primary runtime-aligned harness is now `scripts/tts-realtime-asr-loop-check.mjs`, which sends audio through the face-app websocket route first and only uses batch ASR when the realtime result would fall back.
- The case file separates `displayText` (what the UI should show) from `ttsInput` (what should actually be spoken).
- Cases that begin with kanji may allow an optional leading `はい、` in the observed transcript because of the current Qwen3 English-profile filler behavior.

## Workflow

1. Update `cases.json` with new phrases or acceptance notes.
2. Run `node scripts/tts-realtime-asr-loop-check.mjs --tts-source face` for the runtime-aligned loop.
3. Use `node scripts/tts-asr-loop-check.mjs` when you specifically want the batch-only fallback path in isolation.
4. Review `latest-realtime-report.md` or `latest-report.md`.
5. Record any human conclusions or follow-up ideas here.

## Candidate TTS Improvements

- Plain uppercase alphabet runs of length `2..8` are now converted into kana spellings during Qwen3 speech preparation. This covers cases such as `PR`, `CI`, `SSH`, and `HTTP`.
- Remaining candidates are mixed-form tokens that include punctuation or casing changes (for example `CI/CD`, `Node.js`, or product-specific spellings). Those still need explicit policy decisions and regression checks.
- Treat these speech-only rewrites as TTS readability optimizations, not as a replacement for the closed-loop harness. The harness should still verify whether the spoken form improves downstream ASR.

## Human Review Log

- Pending: No manual review entries yet.
