---
status: exploring
---

# Companion execution runtime

Build the host layer between the existing state-extraction core, domain features
such as adaptive guidance, and presentation clients such as the TUI. The runtime
owns the persistent agent session, the single consuming diff reader, durable state
event delivery, background worker execution, and orderly process lifecycle. It
does not decide what game guidance means or how that guidance is displayed.

## Ownership boundary

- `core/` owns save discovery, stability checks, state extraction, digest and
  diff computation, baseline correctness, and historical walk-back.
- The runtime supervises those core entry points, owns the single consuming
  reader, journals state events durably, hosts the agent session, executes
  background work, and coordinates cancellation and shutdown.
- Domain features decide what work should run, its priority and visibility, and
  the state transitions of their own records.
- Presentation clients render projected records and invoke runtime or domain
  commands. They do not write baselines or domain state directly.

The shared lifecycle and projection rules live in
[Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Candidate slices

These are provisional design seams, not the formal `**Slices:**` contract used
by the backlog index. They gain gates and MVP status only after their interfaces
and failure behavior are specified.

### Single-session state coordinator

Host one configured agent session and one adapter. Supervise the existing core
commands, expose streaming chat, freshness and classified error state, and a
host-facing interaction event surface. Own the only consuming diff reader and
retain each pending state event durably before its underlying change can be
considered delivered. Replay unacknowledged events after app or session restart
and support clean shutdown without abandoning consumption or presentation state.

This is the likely runtime MVP. The unresolved design choice is the exact
protocol that couples durable event creation with baseline advancement without
weakening the core's single-writer contract.

### Turn-context acquisition bridge

Provide `core/Get-TurnContext.ps1` as the host-facing entry point for the current
CLI companion while the persistent runtime remains unimplemented. The host calls
one acquisition transaction at the start of each game-related turn and skips it for
repository, backlog, and feature-design conversation. The transaction includes the
single prescribed not-consumed in-process attempt retry when needed. The host invokes
the wrapper once; it never invokes or captures an individual attempt.

`Get-TurnContext.ps1` captures candidate envelopes and typed consumption results in
private memory, validates them, selects the final result, and discards rejected or
superseded full envelopes before returning. It emits only one selected envelope on exit
0 or one bounded terminal diagnostic on exit 1. A malformed or invariant-breaking
candidate is fail-closed `[protocol]`; a consumed cache failure selects that attempt
with `cacheDegraded: true`; and a not-consumed baseline failure permits exactly one new
attempt, which may select a newer save. The host validates successful stdout once more
before injection and never infers consumption from free-form stderr. Successful stderr
is empty; typed degraded-state notices travel in the envelope's validated `warnings`
array. Failure records use canonical unbracketed class tokens in both their terminal
prefix and JSON diagnostic. Section 7.5's
structured result contract and exhaustive transaction table are authoritative.

The authoritative acquisition algorithm, source-identity order, exact envelope,
failure taxonomy, consumption lock, retry behavior, and verification matrix live
in section 7.5 of
[State extraction](../specs/state-extraction.md#75-game-turn-acquisition-get-turncontextps1--adapter-name--companionroot-path).
The bridge returns each diff with the exact digest source receipt it targets. Candidate
payload values are built before baseline mutation but remain private until transaction
selection, preventing a superseded retry payload from entering the host transcript.

The watcher remains a precomputation optimization. The bridge remains the
correctness guard when the watcher is late, stopped, or temporarily regresses
`current.json`. It follows the configured adapter's loaded timeline; it does not
claim playthrough identity, which remains a later runtime concern.

This is an explicit temporary exception to the runtime ownership boundary: the
core bridge owns consumption until the runtime coordinator exists. It creates no
durable event, acknowledgement, or second persistence layer, and it retains the
documented crash-loss window between successful consumption and model delivery.
The runtime replaces the bridge with the durable state-event lifecycle rather
than wrapping it.

### Background work broker

Execute domain-supplied work with bounded concurrency, priority, cancellation,
retry, offline handling, rate limiting, and coordinated shutdown. The broker
knows how to run and persist work attempts, but not whether research is useful,
player-visible, or spoiler-safe. Those are domain decisions.

### Adapter catalog and session isolation

Enumerate installed adapters and isolate agent sessions, state-event journals,
domain persistence, and user preferences by adapter and playthrough. A
single-adapter runtime can ship before this generalization.

### Proactive notice delivery

Deliver domain-produced, spoiler-projected notices between questions without
turning hidden enrichment into inbox entries. Preserve ordering with pending
state events and ordinary responses, and retain notices until acknowledged by a
presentation client.

## Open design questions

- Select and verify the Agent SDK, authentication, and packaging path.
- Define the durable consumption protocol shared with `Get-Diff.ps1`.
- Define playthrough identity before session and event isolation ship.
- Define process recovery when a core command, agent session, or presentation
  client exits mid-operation.
- Define the minimum host API needed by the TUI without coupling it to Ink or
  another presentation library.
- Define the play-session start and end boundary: the session focus dial
  (auto-revert to balanced) and the psychologist persona (end-of-session
  report) both depend on a session-end signal; define the signal and its
  owner once for both.
