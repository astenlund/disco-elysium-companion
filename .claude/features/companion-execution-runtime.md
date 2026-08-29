# Companion execution runtime

Build the host layer between the existing state-extraction core, domain features such as adaptive guidance, and presentation clients such as the TUI. The runtime owns the persistent agent session, the single consuming diff reader, durable state event delivery, background worker execution, and orderly process lifecycle. It does not decide what game guidance means or how that guidance is displayed.

## Ownership boundary

- `core/` owns save discovery, stability checks, state extraction, digest and diff computation, baseline correctness, and historical walk-back.
- The runtime supervises those core entry points, owns the single consuming reader, journals state events durably, hosts the agent session, executes background work, and coordinates cancellation and shutdown.
- Domain features decide what work should run, its priority and visibility, and the state transitions of their own records.
- Presentation clients render projected records and invoke runtime or domain commands. They do not write baselines or domain state directly.

The shared lifecycle and projection rules live in [Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Slices

The MVP and continuations below form the formal `**Slices:**` contract in `FEATURES.md`. The single-session state coordinator, the durable-consumption protocol, play-session lifecycle, playthrough identity, session-host seam, and process recovery have their interfaces and failure behavior specified; the remaining slices are provisional seams whose interfaces still gain gates before they ship.

### Single-session state coordinator (MVP)

Host one configured agent session and one adapter. Supervise the existing core commands, expose streaming chat, freshness and classified error state, and a host-facing interaction event surface. Own the only consuming diff reader and retain each pending state event durably before its underlying change can be considered delivered. Replay unacknowledged events after app or session restart and support clean shutdown without abandoning consumption or presentation state.

This is the runtime MVP. The exact protocol that couples durable event creation with baseline advancement is settled: the core appends the event record inside the same `consume.lock` transaction that advances baseline, so baseline advance is the outbox commit (see [consumer transaction coupling](../patterns/runtime-work-projection-persistence-boundaries.md#consumer-transaction-coupling-settled-protocol)).

### Background work broker

Execute domain-supplied work with bounded concurrency, priority, cancellation, retry, offline handling, rate limiting, and coordinated shutdown. The broker knows how to run and persist work attempts, but not whether research is useful, player-visible, or spoiler-safe. Those are domain decisions.

### Adapter catalog and session isolation

Enumerate installed adapters and isolate agent sessions, state-event journals, domain persistence, and user preferences by adapter and playthrough. A single-adapter runtime can ship before this generalization.

### Proactive notice delivery

Deliver domain-produced, spoiler-projected notices between questions without turning hidden enrichment into inbox entries. Preserve ordering with pending state events and ordinary responses, and retain notices until acknowledged by a presentation client.

## Turn-context acquisition bridge (shipped, pre-coordinator)

The bridge is live production behavior, not a runtime slice: it carries consumption until the coordinator exists and is replaced, not wrapped, when the coordinator ships. See the FEATURES.md entry, which excludes it from the slice breakdown.

Provide `core/Get-ValidatedTurnContext.ps1` as the host-facing entry point for the current CLI companion while the persistent runtime remains unimplemented. The host calls it once at the start of each game-related turn and skips it for repository, backlog, and feature-design conversation. It invokes `core/Get-TurnContext.ps1` exactly once as a child, captures its complete streams, validates the selected envelope or terminal diagnostic, resolves one fresh Acquisition config, and adapter-admits the nested state before returning the original complete envelope unchanged. This gives Codex and Claude Code one identical command and removes host-authored capture and validation scripts. The transaction includes the single prescribed not-consumed in-process attempt retry when needed. Neither host-facing layer invokes or captures an individual attempt. If the final raw-byte write fails, the entry returns a consumed `[delivery]` diagnostic; any partial stdout is rejected rather than injected.

`Get-TurnContext.ps1` captures candidate envelopes and typed consumption results in private memory, validates them, selects the final result, and discards rejected or superseded full envelopes before returning. It emits only one selected envelope on exit 0 or one bounded terminal diagnostic on exit 1. A malformed or invariant-breaking candidate is fail-closed `[protocol]`; a consumed cache failure selects that attempt with `cacheDegraded: true`; and a not-consumed baseline failure permits exactly one new attempt, which may select a newer save. `Get-ValidatedTurnContext.ps1` validates the inner successful stdout once more before returning it and never infers consumption from free-form stderr. Successful stderr is empty; typed degraded-state notices travel in the envelope's validated `warnings` array. Failure records use canonical unbracketed class tokens in both their terminal prefix and JSON diagnostic. Section 7.5's structured result contract and exhaustive transaction table are authoritative.

The authoritative acquisition algorithm, source-identity order, exact envelope, failure taxonomy, consumption lock, retry behavior, and verification matrix live in section 7.5 of [State extraction](../specs/state-extraction.md#75-game-turn-acquisition-validated-host-entry-and-consuming-transaction). The bridge returns each diff with the exact digest source receipt it targets. Candidate payload values are built before baseline mutation but remain private until transaction selection, preventing a superseded retry payload from entering the host transcript.

The watcher remains a precomputation optimization. The bridge remains the correctness guard when the watcher is late, stopped, or temporarily regresses `current.json`. It follows the configured adapter's loaded timeline; it does not claim playthrough identity, which the runtime resolves from the signed-in Windows principal at startup (see the [playthrough identity](../patterns/runtime-work-projection-persistence-boundaries.md#playthrough-identity-settled)).

This is an explicit temporary exception to the runtime ownership boundary: the core bridge owns consumption until the runtime coordinator exists. It creates no durable event, acknowledgement, or second persistence layer, and it retains the documented crash-loss window between successful consumption and model delivery. The runtime replaces the bridge with the durable state-event lifecycle rather than wrapping it.

## Settled design decisions

- The session-host seam is settled, with a primary provider and declared alternates. The runtime exposes a provider-neutral session-host contract (see the TUI draft's session-host seam bullet): a conversation event stream, host dialog callbacks, per-question model override, and resume-by-id. The first provider is the Claude Agent SDK (TypeScript, streaming mode) as the same engine as Claude Code; it reuses the `claude /login` OAuth, bundles the native binary, and resolves session ids. Declared alternates are Codex CLI, Claude Code via an alternate endpoint (OpenRouter), and a local llama.cpp gateway; each asserts its own capabilities, and hosts degrade visibly when a capability is absent rather than faking it. The `claude -p --resume` fallback is retired to cold-start since it cannot intercept dialog tool calls.
- The durable consumption protocol is settled: the core appends a durable event record inside the same `consume.lock` transaction that advances baseline, making baseline advance the outbox commit so consumption and replayability are one fact. See [consumer transaction coupling](../patterns/runtime-work-projection-persistence-boundaries.md#consumer-transaction-coupling-settled-protocol).
- Playthrough identity is settled: the runtime resolves it from the signed-in Windows principal at startup, with no user-selectable profiles anywhere. The isolation key is (adapter, principal identity). See [playthrough identity](../patterns/runtime-work-projection-persistence-boundaries.md#playthrough-identity-settled).
- Process recovery is settled: core commands are crash-safe by atomic writes and lock release, bounded retry plus reaping covers transient failures, an agent session reattaches by id and replays unacknowledged events, a client detach never ends a session, and startup reconciliation compares the recorded game process id against the live process to tell "same sitting continued" from "previous sitting ended and a new one began." See [process recovery](../patterns/runtime-work-projection-persistence-boundaries.md#process-recovery-settled).
- The minimum host API is settled as the session-host seam owned by the TUI draft: conversation stream, host dialog callbacks, session control, and per-question model override, all provider-agnostic so the TUI never imports a provider library; the runtime exposes the seam.
- The play-session start and end boundary is settled: the runtime owns the session lifecycle and emits a durable session-end event with two causes (game process exit; explicit user sign-off). The session focus dial and the psychologist persona report both consume it. See the [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle).
