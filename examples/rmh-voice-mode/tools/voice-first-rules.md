<!--
  Source of truth for the voice-first rule set used in
  examples/rmh-voice-mode/{CLAUDE,AGENTS,GEMINI}.md.

  When you edit this file, run:
      examples/rmh-voice-mode/tools/regenerate-rules.sh

  to refresh the three CLI-facing copies.
-->

# Real Minimum Headroom — Voice-First Mode

This working directory configures the agent for **Real Minimum Headroom (RMH)** — the AtomS3R desk device — as the primary output surface. You are talking to a user who is not necessarily watching a screen. The face on the AtomS3R is the user-facing UI. Audio is the user-facing channel.

The agent loaded from this directory must follow the rules below **in addition to** any general project rules and any global `~/.claude/CLAUDE.md` (or equivalent) policy.

## 1. Speak the answer, not just the status

This is the single rule that makes RMH usable.

- **Every response you give to the user MUST be spoken via `face_say` first.** The text you would normally render in the terminal is delivered as voice to the AtomS3R.
- Speak the **substantive content** of the answer — not a status summary, not a "done!" line.
- Keep meaningful specificity. A useful voice answer is roughly **1–4 spoken sentences**; pass them as one `face_say` call. The server segments long text on sentence boundaries automatically (`MH_TTS_CHUNK_MAX_CHARS=64`, JA/EN aware), so you do not need to pre-chunk.
- If a long answer would not fit in voice, **say a faithful summary aloud, then keep the full text in the terminal output** for later visual reference. Do not collapse the answer to a one-liner just because it is voice.

Exploratory or open-ended user questions: still answer in voice, even if the answer is "I have two options; option A would …; option B would …". Do not defer the substance to the next turn.

## 2. Avoid screen-only language

The listener may have no screen in view. Speak in self-contained sentences.

- Do not say "as shown above", "the diff below", "see the table", "click the red button", "open this file".
- Refer to files and code by **name and purpose**, not by spatial reference: "the operator stack script at `scripts/run-operator-stack.sh`" rather than "the script above".
- Read URLs only when the user explicitly needs to dictate or type them. Otherwise summarize ("the project README on GitHub") and keep the URL in the terminal text.
- For code, commands, long identifiers, and stack traces: **summarize verbally** ("I'll add a 64-character chunk cap to the operator stack launch script"), and keep the literal command/code in the terminal text where the user can copy it later.

## 3. Conversational rhythm

- Default to one `face_say` per assistant turn that contains the meaningful answer.
- Use `priority=2`, `policy="enqueue"` for normal answers.
- Reserve `priority=3, policy="interrupt"` for things that genuinely need to interrupt the user — failure notices that block progress, and **permission prompts** (see §5).
- Sparse progress nudges (long-running task heartbeats) should be `priority<=1` and **rare**; one every 20–30 seconds at most, not every step.
- Include `message_id` and `revision = Date.now()` on every `face_say` so the face renders even when the wording is similar to a prior utterance.

## 4. Required status signaling

These are unchanged from the standard Minimum Headroom signaling baseline (see `doc/examples/AGENT_RULES.md` in the repository). Voice mode does not replace them; it **adds** §1–§3 on top.

- Near task start: `face_event(name="cmd_started", severity=0.3, meta={...})`.
- On failure: `face_event(name="cmd_failed", severity=0.7, meta={cmd, exit_code, ...})` plus a concise spoken failure summary at `priority=2`.
- On success checkpoint: `face_event(name="cmd_succeeded", severity=0.5, meta={...})` plus a concise spoken summary at `priority=2`.
- On retry: `face_event(name="retrying", severity=0.5, meta={attempt, ...})`.
- Returning to neutral after a turn: `face_event(name="idle", severity=0.1~0.3, meta={...})`. **This is non-optional in voice mode** — the hook-bridge's idle safety net is suppressed (see `MH_HOOK_SUPPRESS_EVENTS=idle_after_response` exported by `start-rmh.sh`), so if you forget to emit `idle`, the face stays in its last expression instead of returning to neutral.

## 5. Permission flow (critical)

When you need user approval for a destructive or shared-state action:

1. Emit `face_event(name="permission_required", severity=0.9, meta={action, ...})`.
2. Emit `face_say(priority=3, policy="interrupt")` with a short, varied phrase (3–8 words English, or one short Japanese clause). Vary the wording between successive prompts — do not repeat the exact same sentence.
3. **Then** ask the user in chat.

Do not ask for approval in chat before the two signals above are emitted. Treat the approval wait as `needs_attention`, not as `idle`.

## 6. Identity

- `agent_id` is auto-filled from the `MH_FACE_AGENT_ID` environment variable (set to `__operator__` by `start-rmh.sh`). **Do not pass `agent_id` manually** unless you are sure this process is acting as a helper, not the operator pane.
- `session_id` is auto-filled from `MH_FACE_SESSION_ID`. You do not need to set it.
- `face_ping` once near the start of a non-trivial task to confirm connectivity. After that, rely on `face_event` / `face_say`.

## 7. What not to read aloud

To keep voice useful, deliberately exclude:

- Raw error stack traces — summarize in plain language ("the build failed because the package version cannot be resolved").
- Generated diffs, table dumps, JSON blobs, base64 strings.
- File/line citations like `src/foo.ts:42:7` — say "in the foo source file" instead, keep the precise citation in the terminal.
- Repeated boilerplate ("I'll now read the file", "let me check"). If you must report a tool call, do it once per logical step, not per tool invocation.

## 8. Degraded mode

If the MCP `face_say` call fails:

- Report the degradation **once** in the terminal text.
- Continue the user-requested work.
- Resume `face_say` signaling automatically when MCP recovers.

If the AtomS3R hardware itself is unreachable (operator stack is up but device is offline), the face-app will still hold messages; do not loop retries. Complete the work and surface a brief "no audio" status when the next turn ends.
