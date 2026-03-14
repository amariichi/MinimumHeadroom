# Multi-Agent Orchestration Spec (Draft)

This document is a design specification, not an ExecPlan. Its job is to freeze the product and protocol rules for operator-led multi-agent work before implementation planning begins.

The target outcome is a system where a user continues to interact primarily with one visible `operator`, while that operator can create helper agents, collect their results, and surface only the necessary decisions back to the user without exposing helper-internal confusion or half-formed questions.

This draft is intentionally critical and conservative. It prefers clear ownership, auditable message flow, and recoverable failure behavior over maximal autonomy.

Normative language in this document should be interpreted as follows:

- `must`: protocol invariant or correctness requirement
- `should`: version-one product recommendation
- `may`: future option or non-required extension

## 1. Problem Statement

The repository already supports multiple visible agents on desktop, plus add/focus/delete lifecycle controls. What does not yet exist is a robust orchestration model for time.

The main problem is stall. When `operator` is waiting for user input on stdin, orchestration slows or stops. In that state, helper agents may finish, may block, or may need clarification. If those reports are not captured and surfaced cleanly, the whole multi-agent loop becomes fragile.

The second problem is conversational ownership. The user usually did not delegate work directly to helper agents. The user delegated work to `operator`. If helper agents ask the user questions directly, the user must reconstruct internal decomposition that only `operator` knows. That is poor UX and will fail often.

The third problem is heterogeneous agents. This repository can host more than Codex. A future workflow might use one Gemini-like agent for design ideation, one Codex helper for implementation, and another Codex helper for review. The orchestration rules must therefore avoid product-specific assumptions whenever possible.

The fourth problem is false confidence from weak lifecycle signals. This repository can infer `prompt_idle` from activity silence, but that signal is not authoritative enough to drive orchestration decisions by itself. A helper can appear quiet because it is finished, because it is blocked, or because the owner is stalled.

For version one, this specification assumes bounded concurrency on the visible desktop surface. The current product cap of `operator + up to 7 helper agents` is not a protocol problem by itself. It is a user-experience and implementation bound. The orchestration rules in this document should remain valid within that cap and should not assume unbounded simultaneous helpers in the first release.

## 2. Core Product Principle

The user-facing owner of a work stream is exactly one agent.

In the normal case that owner is `operator`. Helpers work under that owner. Helpers may report, escalate, or ask for clarification from the owner, but helpers do not directly ask the user for guidance.

If the user intentionally launches another top-level agent as a separate work stream, that agent becomes the owner of its own stream. The same rule still applies: each stream has one user-facing owner, and only that owner may ask the user for decisions.

This rule exists to prevent conversational fragmentation.

## 3. Roles

### 3.1 Operator

`operator` is the user-facing owner.

Responsibilities:

- accept user instructions
- decide whether work should remain single-agent or be decomposed
- spawn and delete helper agents
- assign mission and role to each helper
- collect helper results
- decide when a helper question can be answered internally
- ask the user only when user judgment is actually needed
- integrate results back into the main work stream

Non-responsibilities:

- operator does not need to perform all low-level coding itself
- operator should not manually poll every helper terminal just to know whether work progressed

### 3.2 Helper Agent

A helper agent is a subordinate worker. Examples:

- implementation helper
- investigation helper
- review helper
- test-confirmation helper
- design ideation helper

Responsibilities:

- perform its assigned mission
- report progress or completion to the owner
- raise blocking issues to the owner
- avoid direct user-facing questions

Non-responsibilities:

- helpers do not independently redefine scope
- helpers do not directly ask the user for clarification unless they themselves are the explicit owner of a separate user-launched stream

### 3.3 Owner Inbox Service

Version one should not introduce a second decision-making agent called `coordinator`.

Instead, it should introduce a simple always-on repository function called the owner inbox service. This is not a personality, not a reviewer, and not a second operator. It is only a mailbox and attention-tracking layer that keeps helper reports from being lost while the owner is stalled on stdin.

Responsibilities:

- receive helper reports even while `operator` is waiting
- queue unresolved reports
- mark related tiles or controls as `needs_attention`
- preserve enough state that browser reloads do not erase unresolved work

Non-responsibilities:

- the inbox service does not make user-level decisions
- the inbox service does not replace `operator` as the user-facing owner
- the inbox service does not ask the user anything

## 4. Ownership and Communication Rules

### 4.1 Ownership Rule

Every work stream must have one `owner_agent_id`.
Every work stream must also have a stable `stream_id`.

The owner:

- may ask the user for decisions
- receives helper escalations
- owns final integration and closeout

All subordinate agents in the stream must point to that owner.

Visible focus does not transfer ownership.

Selecting or mirroring a helper in the UI does not make that helper user-facing. Focus is a viewing operation. Ownership transfer, if ever supported later, must be an explicit protocol action and is out of scope for version one.

### 4.2 Allowed Communication

Allowed by default:

- user -> owner
- owner -> helper
- helper -> owner
- owner inbox service -> owner (notification/state only)

Not allowed by default:

- helper -> user
- helper -> helper direct communication

Helper-to-helper direct communication may be considered later, but only after the repository has strong logging, clear arbitration, and a way to preserve responsibility boundaries. It is explicitly out of scope for the first orchestration implementation.

### 4.3 Authority Model

The specification should distinguish responsibility from authority.

Version-one authority rules should be:

- only the owner of a stream may ask the user for decisions
- only helpers belonging to a stream may submit reports into that stream's owner inbox
- focus, visibility, or mirror selection do not grant user-facing authority
- review helpers should default to `read_only`
- write authority should be treated as mission-scoped, not implied forever by agent existence

Runtime enforcement may begin lightweight in version one, but the authority model itself must be explicit in the specification.

### 4.4 Why Direct Helper Communication Is Rejected Initially

Cause:

- two helpers coordinate directly

Effect:

- operator may lose the authoritative picture of the work
- responsibility for a wrong decision becomes unclear
- review findings can be merged without a clear owner decision
- the user may be asked about an internal disagreement without context

Therefore, all coordination must flow through the owner in the initial version.

## 5. Work Item Model

Each helper should be created with a small structured mission, even if the current UI shows it as plain text.

Minimum mission fields:

- `stream_id`
- `mission_id`
- `role`
- `goal`
- `constraints`
- `expected_output`
- `owner_agent_id`
- `review_policy`

Examples:

- `role=implementation`, `goal=add browser audio fallback test`, `expected_output=patch + tests`
- `role=review`, `goal=review PR-sized diff for regressions`, `expected_output=findings only`, `review_policy=read_only`

The purpose of this structure is to reduce vague helper launches that later require re-explaining context.

### 5.1 Identity Model

Version one should distinguish stream identity from mission identity.

Minimum identity fields should therefore be:

- `stream_id`
- `mission_id`
- `owner_agent_id`
- `from_agent_id`
- optional `delegated_by_agent_id` or `parent_agent_id`

Why this matters:

- a user may launch multiple top-level streams
- an owner may delete and recreate a helper
- one helper may receive a new mission later
- unresolved reports may survive browser reloads or reconnects

`owner_agent_id` alone is not enough to disambiguate which unresolved work belongs to which active flow.

## 6. Report and Escalation Model

Helper output to the owner should be structured, even if it is rendered in UI as a short line plus status color.

Minimum report kinds:

- `progress`
- `done`
- `question`
- `blocked`
- `review_findings`
- `error`

Minimum report fields:

- `stream_id`
- `mission_id`
- `report_id`
- `from_agent_id`
- `owner_agent_id`
- `kind`
- `summary`
- `detail`
- `requested_action`
- optional `blocking`
- optional `severity`
- optional `supersedes_report_id`
- `ts`

Examples of `requested_action`:

- `none`
- `answer_me`
- `ask_user`
- `switch_focus`
- `review_needed`
- `terminate_me`

### 6.1 Important Rule: Helpers Escalate, They Do Not Ask the User

Cause:

- helper hits ambiguity

Bad behavior:

- helper asks the user directly

Why this is bad:

- the user may not know what that helper was doing
- the user may not know how the larger task was decomposed
- the user may answer in a way that contradicts owner context

Required behavior:

- helper emits `question` or `blocked` report to owner
- owner either answers directly or reformulates the issue for the user

### 6.2 Minimum Report Protocol for Version One

The first implementation should add an explicit repository-local report message instead of trying to infer orchestration state from terminal text alone.

Recommended logical shape:

- `type = "agent_report"`
- `stream_id`
- `mission_id`
- `owner_agent_id`
- `from_agent_id`
- `kind`
- `summary`
- `detail`
- `requested_action`
- optional `blocking`
- optional `severity`
- optional `supersedes_report_id`
- `report_id`
- `ts`

This does not require a public MCP tool immediately. It only requires a stable internal contract somewhere in the repository so the UI and runtime can store and render unresolved reports.

### 6.3 Report Lifecycle

Version one should make report lifecycle explicit.

Minimum report states should be:

- `submitted`
- `delivered_to_inbox`
- `seen_by_owner`
- `acted_on`
- `resolved`
- `superseded` or `dismissed`

The following rules should apply:

- unresolved attention must persist until a report is `resolved`, `superseded`, or `dismissed`
- merely seeing a report does not automatically clear attention
- only the owner may mark a report `resolved` or `dismissed`
- a helper may supersede its own earlier report by sending a new report with `supersedes_report_id`
- `done` does not imply automatic resolution; it means the helper submitted its expected output

This distinction prevents "owner has seen it" from being confused with "the issue is actually settled."

For version one, these terms should be interpreted as:

- `superseded`: replaced by a newer report that should now be treated as authoritative
- `dismissed`: intentionally closed by the owner as not requiring further action
- `stale`: no longer current because the mission or stream became obsolete, but still useful as historical context

`stale` should not be treated as a primary lifecycle state in version one. It is better understood as a classification or archival reason that may coexist with `dismissed`, `superseded`, or stream-closure handling.

### 6.4 Ordering and Idempotency

Version one should assume retries, reconnects, and duplicate delivery can occur.

The minimum rules should be:

- `report_id` must be unique within its stream
- inbox append must be idempotent by `stream_id + report_id`
- the inbox should assign a stable per-stream acceptance order when reports are accepted
- UI ordering should use inbox acceptance order or that stream-local sequence, not wall-clock `ts`
- `ts` is display metadata, not the source of truth for ordering

These rules are intentionally simple and should be preferred over clock-based ordering claims.

### 6.5 Report Semantics for Attention

Version one should distinguish at least three semantic classes even if the first UI uses similar colors:

- blocking attention: owner judgment is required before useful progress can continue
- informational attention: owner should inspect a result, but work is not hard-blocked
- error attention: failure or broken runtime condition

`question`, `blocked`, and some `review_findings` are often blocking.
`done` is usually informational unless the mission explicitly requires immediate owner review before continuation.

At the state-machine level, `needs_attention` should be treated as the umbrella condition "an unresolved owner-facing item exists." Blocking attention and informational attention are subtypes of that umbrella. `error` remains distinct.

This separation is needed so the UI does not degenerate into "everything red means the same thing."

### 6.6 Meaning of `done`

`done` should mean that the helper has submitted the output it was asked to produce.

It should not automatically imply:

- owner has reviewed that output
- the mission is fully accepted
- the helper must be terminated immediately

If version one needs more detail later, it may add fields such as:

- `awaiting_owner_review`
- `terminal`

But even before those fields exist, the semantic distinction should remain explicit.

## 7. Stall and Time Behavior

### 7.1 Key Observation

When `operator` is waiting for user stdin, orchestration by `operator` stalls.

This is not a bug in the repository. It is a fundamental limitation of a user-facing interactive agent loop.

### 7.2 Consequence

A time-resilient orchestration system cannot rely only on the live attention of `operator`.

There must be an intermediate mechanism that continues to capture helper state changes while `operator` is waiting. In this specification, that mechanism is called the owner inbox service. Its only required effect is that unresolved helper reports must not be lost.

The implication is that `prompt_idle` cannot be treated as sufficient proof that a stream is truly safe to ignore. The system must prefer explicit unresolved reports over silence-derived calm states.

### 7.3 Required Behavior During Stall

Cause:

- `operator` is waiting for user input
- helper emits `done`, `blocked`, `question`, or `review_findings`

Effect that must happen:

- the report is durably queued
- the relevant helper tile becomes `needs_attention` or `error`, depending on report semantics
- the owner stream becomes visibly attention-seeking
- the user can see that there is pending work needing inspection

Effect that must not be required:

- operator must not have to already be actively polling the helper pane

### 7.4 Practical First-Version Interpretation

The first version does not need a separate autonomous coordinator agent. It only needs:

- a durable inbox for helper reports
- visible `needs_attention`
- a reliable way for `operator` to drain that inbox after user interaction resumes

This keeps implementation scope realistic.

In other words, version one should implement a mailbox service, not a second autonomous brain.

### 7.5 Cancellation, Timeout, and Orphan States

Version one should define the minimum behavior for stale or abandoned work.

Required cases:

- if an owner cancels a mission, unresolved reports for that mission should become `dismissed` or `superseded`, not silently remain active forever
- if a helper process dies, unresolved reports should remain visible and the runtime state may additionally become `missing` or `error`
- if a mission becomes obsolete because the owner changed direction, old unresolved reports should be markable as stale rather than left indistinguishable from current work

Process state and mission state are related but not identical. A process can be missing while its prior results still matter, and a process can be alive while its mission is obsolete.

### 7.6 Stream Close Semantics

Version one should define a minimal end state for streams.

At minimum:

- a closed stream must reject or archive newly arriving reports rather than treating them as active unresolved work
- mission cancellation and stream closure should be treated as different events
- if an owner disappears unexpectedly, subordinate work should be treated as orphaned until explicitly closed, archived, or reassigned

This prevents durable inbox state from remaining forever active after the work stream itself has ended.

## 8. Presence and UI Semantics

This section maps orchestration semantics onto the current UI direction of the repository.

### 8.1 Desktop Tile Colors

Current or intended visible tones:

- `active`
- `prompt_idle`
- `needs_attention`
- `error`
- `missing`

New orchestration interpretation:

- `active`: agent is working or recently emitted activity
- `prompt_idle`: agent is quiescent and ready for next work
- `needs_attention`: agent has an unresolved owner-facing report; this may be blocking or informational
- `error`: failure state that is stronger than ordinary attention
- `missing`: runtime record exists but process/worktree/pane is unavailable

The important constraint is that unresolved reports dominate quiet-state inference. If an agent has an unresolved report in the owner inbox, that agent should remain `needs_attention` even if its terminal is now quiet.

If the first UI uses only one attention tone, the subtype distinction must still survive in report metadata and inbox ordering.

### 8.2 User Meaning of Attention Color

Cause:

- helper has an unresolved owner-facing item

Effect:

- tile turns attention color
- short summary remains available

Interpretation:

- the user does not need to inspect all terminals
- the user should ask `operator` about the attention-marked tile, or `operator` should proactively explain it when resumed
- in the first UI, a red or muted-red tile often means blocked progress, but it may also mean an informational unresolved result that still needs owner inspection

### 8.3 Mobile

Mobile has only one large face, so tile-only signaling is insufficient.

The spec therefore requires a mobile-compatible attention affordance. Candidate locations:

- current-agent bar
- input panel border or background
- compact unread-report counter

The first implementation does not need all of them, but it must expose unresolved helper attention without requiring the user to open every agent manually.

For version one, the best tradeoff is likely:

- current-agent bar attention color
- input panel border or background attention color
- optional unread report count if it can be added without clutter

## 9. Owner Inbox / Mailbox Requirements

The first orchestration-capable version should add an owner inbox model.

Minimum behavior:

- append incoming helper reports while owner is stalled
- preserve report order
- allow marking a report as resolved
- allow operator to focus the reporting helper directly from the report
- allow short summaries to remain visible on helper tiles
- preserve enough metadata to sort reports by priority

This inbox does not need to be a full chat transcript. It only needs to preserve actionable reports.

The inbox must be the source of truth for unresolved orchestration work. Browser-local state may cache it for rendering speed, but unresolved report truth must not exist only in the browser.

That means the preferred ownership is:

- durable state in the face-app runtime or another repository-local server-side state store
- mirrored browser state for rendering

This avoids losing unresolved attention if the browser reloads.

### 9.1 Who Checks the Inbox, and When

The inbox exists so unresolved work is not lost while `operator` is stalled. That does not mean `operator` must actively poll it every moment.

Version one should separate two kinds of checking:

- state observation by the runtime and UI
- semantic interpretation by the owner

The runtime/UI side should continuously observe unresolved inbox state so attention is visible even while `operator` is blocked on stdin.

The owner side should interpret and drain that state only at explicit points.

Version-one checking rules should therefore be:

- the runtime/UI continuously reflects unresolved inbox state through tile attention and summary visibility, plus unread count where that affordance exists
- `operator` checks the inbox explicitly when a user turn resumes
- `operator` checks the inbox after sending a user response into its own terminal
- `operator` checks the inbox when switching focus to a helper that is already marked `needs_attention`
- `operator` may check the inbox at major task boundaries such as after finishing a local subtask or before asking the user for a new decision

In other words, the user should be able to notice unresolved helper work without opening terminals, while `operator` should have predictable moments when it drains and interprets queued reports.

### 9.2 Cause and Effect

Cause:

- helper finishes review while `operator` is waiting for user input

Effect:

- report is stored in owner inbox
- helper tile becomes `needs_attention`
- the user can see there is pending unresolved work
- once the user resumes the conversation, `operator` reads the inbox before deciding the next step

Without this rule:

- the inbox exists but has no guaranteed read points
- attention can stay red without a deterministic owner response path

### 9.3 Priority Rules for Inbox Consumption

The first implementation should define a stable owner-facing priority order for unresolved reports.

Recommended order:

1. blocking question
2. hard error
3. blocking review finding or blocking dependency issue
4. done or awaiting-owner-review result
5. informational progress

This order should influence both inbox rendering and any mobile attention summary. Otherwise, the owner can see that attention exists but still lack a deterministic triage rule.

Priority should be derived first from blocking state and runtime error state, then from `kind`, and finally from `severity` only as a tie-breaker.

If `blocking` is absent, the runtime should derive a default from `kind`.

Blocking items should sort ahead of informational unresolved items even if both are rendered under the single umbrella of `needs_attention`.

## 10. Ping / Call / Response Model

Direct stdin injection from helper to operator is rejected for the first version.

Reason:

- it collides with user input
- it is hard to audit
- it creates race conditions during approvals and long output

Instead, the communication should use structured calls.

This call state describes delivery and handshake semantics, not the owner-resolution semantics of the report itself.

Minimum states:

- `accepted`
- `busy_retry`
- `queued`
- `rejected`

Interpretation:

- a helper may attempt an owner call
- if owner is available, the call is accepted
- if owner is stalled, the call becomes queued
- if delivery is impossible or forbidden, the call is rejected

Typical rejection reasons may include:

- `closed_stream`
- `unknown_stream`
- `not_authorized`

In version one, an owner call may be implemented simply as report submission plus inbox state transitions. The call model exists to describe transport and acknowledgement behavior, not to redefine report lifecycle.

This can be implemented without a full RPC system. Even a queued local message model is enough for the first version.

The first implementation should therefore avoid any feature whose success depends on timing a helper message into operator stdin while the user may also be typing.

## 11. Heterogeneous Agent Support

The repository must assume that helper agents may be different products.

Examples:

- Codex helper for implementation
- Gemini-like helper for graphics or ideation
- Codex review helper for regression analysis

Therefore, the orchestration contract must depend only on repository-local primitives where possible:

- tmux pane lifecycle
- worktree lifecycle
- `face_ping`
- `face_event`
- `face_say`
- helper report schema

Product-specific features like Codex `notify` are optional and must not be relied upon for correctness.

This also means the current experimental `notify -> prompt_idle` path should not be part of the orchestration correctness model. It may remain as dormant implementation residue, but version one must work correctly without it and user-facing docs should not advertise it.

## 12. First-Version Non-Goals

These are explicitly out of scope for the first orchestration implementation:

- free-form direct helper-to-helper messaging
- automatic multi-hop delegation by helpers
- helpers spawning helpers without owner approval
- fully autonomous second-agent decisions that bypass owner judgment
- deep semantic merge of helper outputs without operator review

Keeping these out of scope is necessary to avoid building an elegant but unmanageable system.

One more version-one non-goal is automatic user questioning by any non-owner agent.

## 13. Candidate Implementation Shape

This section is not an ExecPlan. It is only a plausible decomposition to test whether the specification is implementable.

Likely building blocks:

- operator-owned inbox data model
- helper report submission path
- UI attention + summary persistence
- owner actions for `answer`, `ask_user`, `focus_agent`, `resolve_report`, `delete_agent`

The implementation order should begin with visibility and durable reports, not with autonomy.

The likely minimum viable sequence is:

1. introduce durable owner inbox state
2. let helpers submit explicit reports into that state
3. map unresolved reports to `needs_attention`
4. let operator inspect and resolve those reports
5. only later consider automation around helper spawning policies or background notification rules

## 14. Reference Patterns From Existing Agent Clients

This repository should learn from existing terminal agent clients, but not copy them blindly.

Public repository structure suggests:

- OpenAI Codex keeps agent runtime concerns inside a dedicated terminal product codebase, with separate CLI and SDK areas rather than exposing multi-agent state as an external browser-first product. The public repository layout includes `codex-cli`, `codex-rs`, `sdk`, and `shell-tool-mcp`, which suggests a strong internal/runtime orientation rather than a user-visible external orchestration dashboard.
- Claude Code exposes extensibility concepts such as commands and plugins in its public repository structure, including `.claude/commands` and `plugins`, which suggests a model where orchestration-related behavior can be layered through command/plugin patterns around the core terminal agent.

For this repository, the lesson is not "match their internal architecture". The lesson is:

- keep orchestration contracts repository-local and explicit
- avoid depending on one product's hidden internal lifecycle
- treat the external UI, face embodiment, and operator workflow as first-class product surfaces

This repository is different because it is not only a terminal agent. It is a visual operator shell around one or more terminal agents.

Sources for the structural observations above:

- https://github.com/openai/codex
- https://github.com/anthropics/claude-code

## 15. Critical Review Questions

This draft must be challenged before any ExecPlan is written.

Questions to review critically:

1. Is `operator` really the only owner we want by default, or are there cases where the user expects a helper to be directly user-facing?
2. Is the owner inbox service alone sufficient in version one?
3. Should `needs_attention` be level-triggered until resolved, or time-limited with refresh?
4. What is the minimum mobile affordance that keeps helper attention visible without clutter?
5. Is helper report structure small enough to be practical, or too formal for real workflows?
6. Should review helpers be explicitly read-only by policy in version one?
7. Does the owner inbox belong in runtime state, browser state, or both?
8. How much of this should be generic repository logic versus agent-instruction policy in `AGENTS.md` or a dedicated skill?
9. Should `prompt_idle` be shown at all when unresolved inbox entries exist, or should attention fully mask it?
10. Do we need any visible inbox affordance beyond tile attention and report summaries?

## 16. Recommended Review Process Before ExecPlan

The next step should not be implementation. It should be critique.

Suggested process:

1. Read this specification only, without implementation files open.
2. Attack it from the perspective of failure cases:
   - operator stalled
   - helper finishes while unseen
   - helper asks a question without enough context
   - user launches multiple independent top-level streams
   - heterogeneous agents disagree
3. Mark which rules feel too strict, too weak, or too expensive.
4. Revise this spec until the ownership and report rules feel stable.
5. Only then write an ExecPlan that implements the reduced, agreed version.

## 17. Current Recommendation

The safest first implementation is:

- keep one user-facing owner per stream
- forbid helper-to-user and helper-to-helper direct questions
- add helper report submission to owner inbox
- drive `needs_attention` from unresolved reports
- let operator resolve or forward only the necessary decisions to the user
- keep `prompt_idle` as a secondary, silence-derived cosmetic state only
- treat review helpers as read-only by default unless the owner explicitly launches them with write authority

This gives the repository a real orchestration foundation without pretending that stdin-stalled operator loops can magically stay fully autonomous.

## 18. Review Findings Applied to This Draft

The first draft of this specification left several things too vague. This revision tightens them so future planning does not drift.

- `prompt_idle` is now explicitly secondary and non-authoritative for orchestration.
- unresolved reports now dominate tone and attention semantics
- the owner inbox is now defined as durable server-side truth, not browser-only UI state
- direct stdin injection is explicitly rejected for version one
- review helpers are now recommended to be read-only by default
- the version-one target is clarified as inbox-plus-visibility, not autonomous coordination
- the term `coordinator` is demoted; version one now talks about an owner inbox service instead of a second agent-like actor
