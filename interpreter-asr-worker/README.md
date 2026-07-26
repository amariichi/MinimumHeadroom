# Interpreter ASR worker

This dedicated worker serves NVIDIA Nemotron 3.5 ASR for the interpreter
stack. It is intentionally separate from the operator ASR environment.

Runtime is offline-only. Run `../scripts/setup-nemotron-asr.sh` once to create
the environment and prefetch the pinned model, then start it with
`../scripts/run-nemotron-asr.sh`.
