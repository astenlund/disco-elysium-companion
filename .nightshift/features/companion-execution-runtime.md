# Companion execution runtime

Build the host layer between the existing state-extraction core, domain features such as adaptive guidance, and presentation clients such as the TUI. The runtime owns the persistent agent session, the single consuming diff reader, durable state event delivery, background worker execution, and orderly process lifecycle. It does not decide what game guidance means or how that guidance is displayed.

## Ownership boundary

- `core/` owns save discovery, stability checks, state extraction, digest and diff computation, baseline correctness, and historical walk-back.
- The runtime supervises those core entry points, owns the single consuming reader, journals state events durably, hosts the agent session, executes background work, and coordinates cancellation and shutdown.
- Domain features decide what work should run, its priority and visibility, and the state transitions of their own records.
- Presentation clients render projected records and invoke runtime or domain commands. They do not write baselines or domain state directly.

The shared lifecycle and projection rules live in [Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Slices

The MVP and continuations below form the formal `**Slices:**` contract in `FEATURES.md`. The single-session state coordinator is designed to decision-complete depth in [Coordinator MVP design](#coordinator-mvp-design). The durable-consumption protocol, play-session lifecycle, playthrough identity, session-host seam, and process recovery have their interfaces and failure behavior settled in the pattern and in [Settled design decisions](#settled-design-decisions); the two slices that implement the rest of that settled material, Play-session lifecycle and Domain command and projection host, are named here and still need their own concrete design before they ship. The remaining slices are provisional seams whose interfaces still gain gates.

### Single-session state coordinator (MVP)

Host one configured agent session and one adapter. Supervise the core commands, expose streaming chat, freshness and classified error state, and a host-facing interaction event surface. Own the only consuming diff reader while the runtime holds consumer ownership, and retain each pending state event durably before its underlying change can be considered delivered. Replay unacknowledged events after app or session restart and support clean shutdown without abandoning consumption or presentation state.

This is the runtime MVP. The durable handoff protocol is settled: each state or domain transition commits its domain-owned state and durable outbox as one durable fact (for a consumed diff, the outbox record is the commit point and the baseline is rolled forward from it), while the runtime separately journals, delivers, acknowledges, and compacts that handoff. See [durable state-event protocol](../patterns/runtime-work-projection-persistence-boundaries.md#durable-state-event-lifecycle). The slice changes the core: it adds the consumer-ownership marker, the state-event outbox, and settlement specified in [state extraction section 7.6](state-extraction.md#76-durable-consumption-consumer-ownership-state-event-outbox-and-settlement). It ships with the bridge still the default consumer; see [Cutover and bridge retirement](#cutover-and-bridge-retirement).

### SessionHostV1 contract (runtime-owned)

`SessionHostV1` is the runtime-owned, provider-neutral, versioned contract consumed by every presentation client. It exposes four faces: a conversation stream of turn deltas, completed turns, and context-compaction boundaries; host dialog callbacks for typed user questions and answers; session control for start, resume-by-id, graceful close, and interruption; and a per-question model override whose scope ends with that question. The runtime carries the current runtime, adapter, binding-epoch, principal, and play-session identities through the contract without exposing them as player-authored content.

Each provider declares the capabilities it can satisfy. A missing or withdrawn capability produces a typed degraded state and disables only the affected operation; the contract never emulates an unavailable dialog, stream, resume, interrupt, or override. Restart and handoff rebind the same logical session only when its identity and current bindings validate; otherwise the runtime fails closed, retains pending work for retry, and keeps commands gated until a valid host and projection are admitted. Provider-specific SDK behavior, authentication, and session transport remain adapter-owned behind this contract.

### Play-session lifecycle

Watch the adapter's game process and own the play-session boundary: validate an OS-backed `gameProcessInstanceIdentity`, mint and persist one `playSessionId` per sitting, accept the player sign-off command, emit one durable session-end event bound to a runtime-owned `sessionCloseId`, keep the close tombstone, and reconcile the recorded process identity at startup. From this slice on, each new sitting starts a fresh agent session and `InteractionContextV1` carries the current `playSessionId`, so every part of the slice can be verified live by starting and quitting the game. The required-consumer reaction ledger for session-end events is not here: it ships with the Domain host slice, where its first consumer arrives (decided 2026-10-05). The interfaces and failure behavior are settled in the pattern's [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle) and [process recovery](../patterns/runtime-work-projection-persistence-boundaries.md#process-recovery-settled) sections. The runtime itself consumes nothing from this slice; it exists because Session focus and the psychologist persona react to its events.

One decision is already made for it. The adapter declares its game process name in an adapter-owned runtime manifest beside `adapter.json`, never in `adapter.json` itself: that file's member vocabulary is closed and any edit changes the configuration receipt an in-flight publisher holds (state extraction section 8). For Disco Elysium the process name is `disco` (probed 2026-10-05: the Steam install's executable is `disco.exe`, and the section 11 live-probe suite already calls `Get-Process -Name disco`).

### Domain command and projection host

Host domain features behind the runtime: admit each `InteractionContextV1` in monotonic order before any domain sees it; route strict-JSON domain commands and return their results; schedule domain-supplied deadlines and report timer failure; signal runtime start; drain registered domain outboxes into the journal and return `outboxSettlement`; rebind projection-bearing and session-close events after a restart; keep the required-consumer reaction ledger for session-end events; acquire the authoritative projection on attach and reconnect; publish volatile projection updates; run the journal-repair handshake with the owning domain; gate commands behind `capability-pending`, `projection-pending`, and pending-reset recovery; and expose the same-principal maintenance channel. The MVP's state-event drain is the first, projection-free instance of the outbox protocol, and this slice generalizes it to registered domains. Session focus's preset MVP is its first consumer and the source of most of its requirements. It requires Play-session lifecycle, because an admitted interaction carries the current `playSessionId`.

### Background work broker

Execute domain-supplied work with bounded concurrency, priority, cancellation, retry, offline handling, rate limiting, and coordinated shutdown. The broker knows how to run and persist work attempts, but not whether research is useful, player-visible, or spoiler-safe. Those are domain decisions.

After startup and pending-reset or handoff gates, the broker rehydrates persisted nonterminal comparison jobs under their original job identities. Queued and retryable jobs resume; interrupted in-flight attempts become retryable rather than complete; terminal jobs remain terminal. Attempt and result identities prevent duplicate application, and restart creates no new comparison job.

### Adapter catalog and session isolation

Enumerate installed adapters and isolate agent sessions, state-event journals, domain persistence, and user preferences by adapter and playthrough. A single-adapter runtime can ship before this generalization.

### Proactive notice delivery

Deliver domain-produced, spoiler-projected notices between questions without turning hidden enrichment into inbox entries. Preserve ordering with pending state events and ordinary responses, and retain notices until acknowledged by a presentation client.

## Coordinator MVP design

This section is the decision-complete design of the [Single-session state coordinator (MVP)](#single-session-state-coordinator-mvp). Its core half (the consumer-ownership marker, the state-event outbox, and settlement) is specified in [state extraction section 7.6](state-extraction.md#76-durable-consumption-consumer-ownership-state-event-outbox-and-settlement) and is not repeated here. Where this section makes a settled decision or pattern rule concrete it says so; where it defers one it names the owner.

One rule shapes every recovery path below. An operation that clears or moves a marker carrying an obligation (the cursor, a journal event, consumer ownership) first writes a durable operation record of what it intends, and every command resumes an incomplete operation record before it chooses any branch. A marker is never the only evidence that work is still owed.

### Scope

Every runtime-owned concern named in this file's settled decisions or in the pattern has one disposition:

| Runtime-owned concern | Disposition |
|---|---|
| Consumer ownership, state-event outbox, settlement acceptance (the core half) | MVP, in state extraction section 7.6. |
| Journal, drain, delivery ledger, settlement send, consumer cursor, acknowledgement, replay, stream repair, retention, and the capacity fault | MVP, for state events and one consumer. |
| `SessionHostV1`, provider capabilities, the Claude Agent SDK provider, agent-session resume and reconnect | MVP. |
| Playthrough identity (the signed-in Windows principal) and the identity-scoped data root | MVP. |
| `runtimeInstanceId`, `runtimeSessionId`, one `adapterBindingEpoch` per process, and each interaction's identity, receipt time, and ingress order | MVP mints and carries them. |
| Core command supervision, watcher supervision, freshness and classified error status | MVP. |
| Model-facing projection of state events | MVP uses the identity projection. The adaptive-guidance disclosure service may replace it later. |
| An in-process text client | MVP, as the verification client. |
| Game-process watch, `playSessionId`, sign-off, durable session-end events, `sessionCloseId`, close tombstone, startup process reconciliation, a fresh agent session per sitting | [Play-session lifecycle](#play-session-lifecycle). Until it ships, `playSessionId` is always null. |
| Interaction admission watermark, domain command surface, deadline timers, runtime-start signal, domain outbox drain and `outboxSettlement`, the terminal-stale delivery ledger, restart rebind, projection acquisition, volatile projection updates, capability-pending and projection-pending, the journal-repair handshake with a domain, the session-end reaction ledger, adapter seed binding, provider raw-text capability states, the maintenance channel | [Domain command and projection host](#domain-command-and-projection-host). |
| Worker execution, retry, offline handling, guidance-resolution results | [Background work broker](#background-work-broker). |
| Adapter enumeration, adapter switching, `handoffIdentity` and its phases, a fresh binding epoch per switch | [Adapter catalog and session isolation](#adapter-catalog-and-session-isolation). |
| Notices between questions, and consuming on a save event | [Proactive notice delivery](#proactive-notice-delivery). |
| A runtime process that outlives its client, and any inter-process client transport | No slice. Decided 2026-10-05: until a slice adds a background process, a client exit is a runtime exit, recovered at the next start (pattern, process recovery). The [TUI companion app](tui-companion-app.md) draft holds the open question of whether it needs one. |
| Walk-back enrichment and the pre-rendered landing brief | The [TUI companion app](tui-companion-app.md) idle-aware recap. A runtime-hosted session skips walk-back until then; the walk is an enrichment, never a gate. |
| Skipping an acquisition when nothing changed, and a persistent core host | Not designed. Decided 2026-10-05: acquire before every message, measure the cost early (state extraction section 11), and only then decide whether either is worth designing. |

### Process, code, and configuration

- **Code.** A new top-level `runtime/` directory holds one TypeScript ES-module package. Node.js runs the sources directly through its built-in type stripping, so there is no build step and no emitted JavaScript (probed 2026-10-05 on the installed Node v22.23.2: both `node --test` and a plain `node <file>.ts` ran TypeScript with no flags). The package therefore uses only erasable TypeScript syntax, pins `engines.node` to `>=22.23`, type-checks with `tsc --noEmit`, and tests with `node --test`. Its only runtime dependency is the provider package named under [Claude Agent SDK provider](#claude-agent-sdk-provider). The PowerShell core stays the state layer and is reached only through its entry scripts.
- **Process model.** One process hosts the runtime and at most one in-process presentation client. `SessionHostV1` messages are plain serializable data, so a later transport can carry the same contract unchanged, but the MVP ships no background process and no inter-process transport. Client exit ends the process. That is a runtime exit, which the durable journal, agent-session resume, and startup recovery below already cover; it loses no event.
- **Single instance.** The pattern's `journal.lock` is realized as a process-lifetime single-instance guard plus one in-process serialized journal queue. The guard is a named pipe `\\.\pipe\game-companion-runtime-<first 32 hex of SHA-256 over the lowercased real path of the data root>`. A second runtime for the same data root fails with `runtimeAlreadyRunning`, and the operating system releases the name when the owner dies, so a crash leaves no stale lock. A pipe is used because Node offers no portable exclusive file share mode (live-claim: not yet probed; a second listener must fail with `EADDRINUSE`, and the name must be free again after the owner is killed).
- **Entry point.** `node runtime/src/cli.ts <command>` has exactly four commands: `chat` (the runtime with the text client; the default), `status` (a read-only report), `consumer <runtime|bridge> [--abandon-undelivered]` (switch consumer ownership), and `repair` (run the stream repair). [Startup, shutdown, and recovery](#startup-shutdown-and-recovery) states what each one runs.
- **Configuration.** `runtime/companion.config.json` is checked in and has exactly `configVersion: 1`; string `adapter` (the adapter directory name, passed to the core as `-Adapter`); string `game` (the adapter identity, which every receipt and record must repeat ordinally); object `provider` with string-or-null `model`, string-or-null `effort`, and object-or-null `questionOverride` (`{ "model": <string>, "effort": <string> }`); and object `watcher` with Boolean `enabled`. An effort value is one of `low`, `medium`, `high`, `xhigh`, or `max`. A missing file, an unknown member, or an invalid value fails with `configurationInvalid`. A null `model` or `effort` means the provider's own default, and `questionOverride: null` means the provider declares no question override. The checked-in file carries the model decision of 2026-08-08 recorded in the TUI draft: a Sonnet-tier default at medium effort and an Opus-tier override at high effort for one question. Exact model identifiers live only in that file.

### Identities

Every identity below follows the shared opaque-token profile and is compared exactly.

- **Principal.** Resolved once per command by the runtime-owned script `runtime/scripts/Get-Principal.ps1`, which prints exactly `{ "sid": <string> }` from `[Security.Principal.WindowsIdentity]::GetCurrent().User.Value`. The SID string is the principal token: the isolation key, the `-Principal` argument of every publish, and the value every drained record must carry. A failed, empty, or malformed result fails with `identityUnavailable`, and no journal access, session, or other core command follows.
- **Adapter.** The adapter identity is the configured `game`. The configured `adapter` only selects the directory, which the core resolves case-insensitively; the two need not be equal. A receipt or record whose `game` differs from the configured one is never accepted.
- **`runtimeInstanceId`, `runtimeSessionId`, and `adapterBindingEpoch`.** Each is 32 lowercase hex from 16 fresh random bytes, minted once per process start before any recovery. `runtimeInstanceId` must differ from the previous start's recorded value and from `runtimeSessionId`; a collision is regenerated up to three times and then fails startup. None is restored after a restart. The MVP has one adapter and never switches, so one epoch lives as long as the process.
- **`journalId`** is minted with the journal. **`eventId`** (`EventIdV1`) is 32 lowercase hex from 16 fresh random bytes and is unique within the journal: a collision with any retained event or compact evidence aborts that append with nothing written, and the retry mints a fresh one. **`interactionId`** is minted the same way, once per player submission and never by a retry or a redraw. An **operation identifier** is `jr-` (repair) or `rl-` (release) followed by 32 lowercase hex from 16 fresh random bytes.

### Storage

The identity-scoped runtime data root is `runtime-data\<game>\<principal>\` under the companion root, and `runtime-data/` joins `.gitignore`. It is inside the repository because the standing hard limit forbids the companion from modifying anything outside it, and it is separate from the core's `state\` so that each root has exactly one owning layer.

```
runtime-data/<game>/<principal>/
  runtime.json                    last start: runtimeInstanceId, startedAt, cleanShutdown, watcher process
  agent-session.json              provider session binding
  operations/<operationId>.json   repair and release records
  quarantine/                     files set aside by a repair
  journal/
    journal.json                  journalVersion, journalId, createdAt, highWaterSequence
    events/<sequence>.json        one event per file; <sequence> is 16 zero-padded decimal digits
    cursor-agent-session.json     the one MVP consumer cursor
```

Every file is written whole through the discipline of state extraction 7.1: a unique sibling temp `<target>.<32-lowercase-hex>.tmp`, complete bytes, flush, close, then rename onto the target. Startup deletes every temp sibling in the data root, which is safe because the single-instance guard proves no other writer exists. The runtime is the only writer and the only reader of this root: the core never opens it, and the hosted session's tools are denied it, so a rename never meets a foreign open handle (live-claim: not yet probed; a Node rename must replace an existing file on this volume). The runtime never writes under `state\`. The provider keeps its own transcript store outside the repository (see the provider section). The runtime does not write that store; it is host-owned, exactly as it is for today's Claude Code companion sessions.

An operation record holds its identifier, kind, cause, and start time; the plan it committed to (for a repair: the last good sequence, the affected events with their readable identities and file hashes, and any cursor position it will write; for a release: its mode and the sequences it abandons); and a completion time and outcome that stay null until it finishes. It records no payload text. A quarantined file is named `<original file name>.<32-lowercase-hex>.quarantined`.

Each durable family is classified as the pattern's retention policy requires. `runtime.json`, `agent-session.json`, `journal.json`, and the cursor are fixed-cardinality records replaced in place. Events follow the journal row of the retention matrix. Operation records follow the row for other terminal operation tombstones. `quarantine\` is diagnostic evidence, never replay input, and keeps at most 256 files, oldest deleted first.

### Core supervision

The runtime runs core entry scripts as child processes through one queue that runs at most one script at a time (the watcher excepted). Each child gets an explicit argument vector with no shell, the companion root as working directory, bounded stream capture, and a deadline after which its process tree is terminated (live-claim: not yet probed; tree termination from Node on Windows).

| Child | Deadline | After termination |
|---|---|---|
| `Publish-StateEvent.ps1` | 3,600 seconds, the outer liveness cap of state extraction 7.5 | Always drain, whatever the exit. |
| `Set-StateEventSettlement.ps1` | 120 seconds | Apply the settlement results below. |
| `Set-CompanionConsumer.ps1` | 120 seconds | Continue the release or hand-over. |
| `Get-Principal.ps1` | 30 seconds | The command proceeds or fails. |
| `Watch-Saves.ps1` | None; long-lived | Restart policy below. |

Every queued child's stdout and stderr are each capped at 65,536 bytes. Capture overflow, a deadline, an abnormal exit code, or an unparseable result is the status class `supervisor` with reason `capture-overflow`, `deadline`, `abnormal-exit`, or `result-invalid`. Terminating a core child mid-operation is the hard-crash path the core already tolerates: atomic state writes, lock release when the holder dies, and reconciliation or the startup reaper for leftovers.

**Watcher.** When `watcher.enabled` is true the runtime keeps one `Watch-Saves.ps1` child alive so `current.json` stays fresh between questions. An exit restarts it after 1, 5, and 30 seconds and then every 60 seconds; a run that survives 10 minutes resets that ladder. Its streams are drained and discarded. The runtime records the child's process id and start time in `runtime.json`; at the next start, a process that still matches both is a watcher orphaned by a crash and is terminated before a new one starts (live-claim: not yet probed). The watcher is a precomputation optimization and never a correctness gate: with it stopped or disabled, every acquisition still refreshes stale state itself. Shutdown terminates its process tree.

**Acquisition.** The runtime runs one `Publish-StateEvent.ps1` transaction at exactly two moments: once during `chat` startup, and once for every admitted chat interaction, before that turn goes to the provider. A save event alone triggers nothing in the MVP. A chat interaction waits for its acquisition to terminate. A failed acquisition does not block the turn: the turn is sent with the failure in its context block, so the agent can still answer what needs no state and must disclose and stop on what does. Four rules govern it:

- The runtime must always hold the state the core last consumed. It passes `-RequireRecord` on the first attempt when its journal holds no uncompacted state-bearing event. When a receipt says `unchanged` but its `target` identity differs from the state of the newest state-bearing event, the runtime's copy is stale (the bridge may have consumed in between), so it runs one more transaction with `-RequireRecord` before the turn proceeds.
- A receipt whose `game` differs from the configured one sets the journal fault `adapterMismatch`.
- A version change is a reset point. When a receipt's `schemaVersion` or `adapterVersion` differs from that of any unacknowledged event, the runtime runs the stream repair with cause `versionChange`. When a publish or a settlement ends `outbox` / `outbox-record-invalid`, it runs the stream repair with cause `coreRejected`.
- While a journal fault is set the runtime runs no acquisition at all: nothing further is consumed, so nothing can be lost behind the fault.

### Journal

One journal event is one file with exactly these fields:

```jsonc
{
  "eventVersion": 1,
  "journalId": "...",
  "sequence": 7,
  "eventId": "...",
  "type": "state.consumed",          // state.consumed | state.snapshot | state.resync
  "occurredAt": "...",               // append time, RFC 3339 UTC with Z
  "runtimeInstanceId": "...",
  "adapter": "disco_elysium",        // the game identity
  "adapterBindingEpoch": "...",
  "principal": "...",
  "logicalOutboxId": "...",
  "recordSha256": "...",
  "schemaVersion": 2,                // copied from the record's nested documents
  "adapterVersion": 2,               // copied from the record
  "settlement": "pending",           // pending | accepted | unknown
  "acknowledgedAt": null,            // set when the event is acknowledged
  "compacted": false,
  "payload": { /* the record's baseline, sourceFloor, refresh, warnings, baselineReset, diff, and state */ }
}
```

The field names it shares with the Session focus event envelope are the same names, so the Domain host slice extends this envelope with `projectionRevision` and `projection` instead of replacing it. The event file is also the delivery-ledger entry for its outbox record: appending the event and recording the outbox identity are one atomic write, so the pattern's "appended but not yet marked" crash state cannot occur for this family.

**Drain.** The drain runs on the journal queue after every publish terminates, at startup, and before every settlement retry:

1. List `state\outbox\` for record file names in ascending sequence, under the runtime read contract of state extraction 7.6.
2. Read each record's bytes once and compute their SHA-256. Parse strictly: UTF-8 without a byte order mark, no duplicate property name at any depth, depth at most 64, and size within the `state-event` budget. Validate the exact root field set and types of 7.6, the `logicalOutboxId` composition, the kind invariants, and the pairwise checks that need no nested validator: `baselineReset` against `baseline` and `diff.baselineGeneratedAt`, `diff.currentSource` and `diff.currentGeneratedAt` against `state`, and version equality between the nested documents. The nested diff and digest are otherwise producer-validated by the core and are carried as opaque JSON.
3. Classify. A record that fails step 2 is `invalid`. A valid record whose `principal` or `game` is not this runtime's is `foreign`. A `logicalOutboxId` the journal already holds with the same `recordSha256` is a duplicate: append nothing, and send its settlement again whatever the event's settlement state, because a record file that is still present has not been retired by the core. The same identifier with a different hash is a `conflict`.
4. Append every other record in order. The next sequence is `highWaterSequence + 1`. Write the event file, which must not already exist, and then raise `highWaterSequence` in `journal.json`. A crash between those two writes leaves one event above the recorded high water, which the next startup accepts by raising it.
5. Send the settlement for every event whose `settlement` is `pending`, and for every duplicate from step 3, in ascending sequence, stopping at the first one that does not end `accepted` or `unknown`. The core accepts settlements only in sequence order.

A `foreign`, `invalid`, or `conflict` record is never appended and stays in the outbox, and the drain stops at it so that order is preserved. `invalid` starts the stream repair below with cause `outboxInvalid`. `foreign` and `conflict` have no automatic repair, because the core considers such a record valid and will never quarantine it: they raise the journal faults `foreignRecord` and `outboxConflict`, whose only resolution is the operator's `consumer bridge --abandon-undelivered` followed by a fresh hand-over.

**Settlement results.** `settled` or `already-settled` marks the event `accepted`. `settlement-unknown` and `settlement-conflict` mark it `unknown`, a terminal state meaning the core holds no pending record for it any more: its evidence was pruned, or the record was abandoned or quarantined. A conflict is logged with both sides' evidence. `settlement-hash-mismatch` means the record's bytes changed after the drain read them; it leaves the event `pending` and raises the journal fault `outboxConflict`. `outbox-record-invalid` starts the stream repair with cause `coreRejected`. Every other failure, `settlement-out-of-order` included, leaves the event `pending` for the next drain. Settlement is asynchronous to the chat turn, which needs only the appended event.

**Cursor and acknowledgement.** The MVP has one consumer, `agent-session`, whose cursor file is exactly `{ "cursorVersion": 1, "journalId": <string>, "consumerId": "agent-session", "lastAckedSequence": <integer>, "lastSentSequence": <integer>, "lastAcceptedRevision": null, "updatedAt": <string> }`; state events carry no domain projection, so the revision is always null. A state event is *delivered* when its diff, with the current state, is placed in a turn's context block. It is *acknowledged* when the provider reports that turn complete and successful. That is the MVP's rendering of the pattern's "durably retained by the active session": the turn, context block included, is then part of the provider's persisted transcript. The model-facing projection is the identity projection: the same spoiler-safe digest and diff the bridge injects today.

Three writes bracket a turn, in a fixed order. Before the turn is sent, the runtime raises `lastSentSequence` to the highest sequence the turn carries; an event above `lastAckedSequence` and at or below the previous `lastSentSequence` has been sent before and is marked `redelivery: true`, and the client receives the notice `stateRedelivered`. If that write fails the turn is still sent, with every event marked as a redelivery. After a successful turn the runtime writes the cursor forward to the highest sequence the turn carried, then stamps `acknowledgedAt` into each acknowledged event file, then updates `agent-session.json`. A turn that fails, is interrupted, or dies with the provider subprocess acknowledges nothing, and neither does a failed cursor write; those events ride the next turn again as redeliveries, which is the accepted duplicate-show side of never-loss. A missing `acknowledgedAt` stamp is filled from the cursor's `updatedAt`, which is never earlier than the true acknowledgement.

**Replay.** After any restart, every event above the cursor is still unacknowledged and rides the first turn in sequence order under its original `eventId` and sequence. State events carry no projection, so the pattern's restart rebind (fresh event identity and a re-derived projection) does not apply to them; rebind arrives with the first projection-bearing event, in the Domain host slice.

**Stream repair.** The journal is contiguous when `journal.json` is valid and every sequence from `lastAckedSequence + 1` through `highWaterSequence` has a valid event file of a supported `eventVersion`. A gap at or below the cursor touches only compact evidence and is logged, not repaired. The runtime checks contiguity at startup and before every delivery; a violation triggers one reread before it counts. The stream repair is the single recovery for every way the event stream can be damaged, and its causes are closed:

| Cause | Detected when | Step 2 does |
|---|---|---|
| `gap` | The contiguity check still fails after the reread. | Moves the first missing, invalid, or unsupported event and every later event to `quarantine\`, and sets the high water to the last good sequence. |
| `outboxInvalid` | The drain meets an `invalid` record. | Nothing. |
| `coreRejected` | A publish or settlement ends `outbox` / `outbox-record-invalid`. | Moves every unacknowledged event to `quarantine\` and sets the high water to the cursor. |
| `versionChange` | A receipt's versions differ from an unacknowledged event's. | The same as `coreRejected`. |
| `capacity` | The operator runs `repair` while `runtimeCapacityExceeded` is set. | The same as `coreRejected`. |
| `lostJournal` | A journal with no event and a high water of 0 is about to append a first record whose outbox `sequence` is above 1: the core has issued records this journal never saw. | Nothing. |
| `header` | `journal.json` is missing or invalid beside any other journal file: the journal's identity is gone. | Moves the journal directory's contents to `quarantine\` and creates a new journal and a cursor at 0. |
| `cursor` | The cursor is missing, invalid, or names another `journalId` beside a valid journal: the acknowledged position is unknown. | Writes a fresh cursor at the high water. |

Every cause runs the same five steps, and each step tolerates being already done:

1. Write the operation record with the cause and its plan. Nothing is moved, and no cursor is written, before this record is durable.
2. Carry out the cause's action from the table.
3. Run `Publish-StateEvent.ps1 -Resync -RepairOperationId <the operation identifier>`. The core quarantines every pending record it rejects, including one whose version or source domain no longer matches the configuration it holds, and commits one `resync` record, or returns `replayed` for a repeat.
4. Drain. A record that is still in the outbox because the core never retired it is taken again as a new event, even if its earlier event was quarantined in step 2; the `resync` event follows it. The recovery event therefore lands after the last good event and after every surviving record. It is the domain's complete safe recovery event: it tells the session that changes may be missing and supplies the full current state.
5. Mark the operation record complete.

Only one repair exists at a time: while an operation record is incomplete no cause is evaluated, and the incomplete repair is resumed first. `lostJournal` cannot recur once the journal holds an event, so it needs no flag. In the `cursor` and `capacity` cases the `resync` tells the session that changes may be missing, which is the cautious reading of a position that cannot be trusted; replaying every retained event instead was rejected because it could flood a session with months of old diffs.

While a repair step is executing, the journal state is `repairing` and a chat submission is rejected with `notReady`. If a step fails, the operation record stays incomplete with the journal and cursor exactly as that step found them, the journal state becomes `fault` with code `repairFailed`, and the repair resumes at the next `chat` or `repair` start. A repair has one terminal failure: if the record that caused `outboxInvalid` is still in the outbox after step 3, the core considers it valid and the runtime does not. The operation record is then completed with outcome `recordRejected` naming that record's file and hash, the journal fault `recordRejected` is derived from it for as long as that file remains, and no further repair is started for the same file. Its resolution is the same operator release as `foreignRecord`.

**Retention.** The pattern's journal row governs events. An event is eligible once it is acknowledged and its settlement is `accepted` or `unknown`. Eligible events older than 180 days, then the oldest beyond 8,192, are compacted by rewriting the event file without `payload` and with `compacted: true`; the compact form keeps every other field, including `acknowledgedAt`. Compact evidence is not deleted in version 1; the pattern defines no bound for it. More than 8,192 uncompacted events with none eligible is the journal fault `runtimeCapacityExceeded`, under which admission fails closed as the pattern requires.

### Agent session delivery

**Context block.** Every turn the runtime sends carries one runtime-authored context block as the first content block of the player's message, and the player's text verbatim as the second. The block is the tag `<companion-turn-context>`, one compact JSON object, and the closing tag. The object has exactly:

```jsonc
{
  "companionTurnContextVersion": 1,
  "interactionId": "...",
  "requestReceivedAt": "...",
  "sessionOpening": false,           // true on the first turn of an agent session
  "freshness": { "state": "fresh", "class": null, "reason": null, "lastGoodGeneratedAt": "..." },
  "degraded": null,                  // null | "eventTooLarge" | "stateTooLarge"
  "events": [ { "eventId": "...", "sequence": 7, "type": "state.consumed", "redelivery": false, "baselineReset": false, "warnings": [], "diff": { /* 7.2 diff, or null */ } } ],
  "state": { /* 6.1 digest */ }      // or null
}
```

`sessionOpening` is true exactly while the bound session's `turnsCompleted` is 0, and `turnsCompleted` rises only when a turn is acknowledged, so a failed first turn leaves the next one opening. `freshness.state` is `fresh` when this interaction's acquisition ended `committed`, `unchanged`, or `replayed`, and `failed` otherwise, with the validated class and reason; under a journal fault it is `failed` with class `journal` and the fault code as its reason. `state` is the digest of the newest uncompacted state-bearing event and is wanted exactly when `events` is non-empty, `sessionOpening` is true, or the session's `needsState` flag is set. `needsState` is set when an agent session starts and whenever the provider reports a context-compaction boundary; it is cleared when a turn that carried `state` is acknowledged, unless a boundary was reported during that same turn. A provider without the compaction capability leaves it permanently set.

The block is capped at 4,194,304 UTF-8 bytes, and delivery always makes progress under that cap:

1. All unacknowledged events in ascending sequence, with the state when it is wanted, if that fits.
2. Otherwise as many events, in order, as fit with the state; the rest ride later turns, still unacknowledged.
3. If the first event alone does not fit with the state, that one event is sent with `diff: null` and `degraded: "eventTooLarge"`.
4. If the state alone does not fit, that one event is sent with `diff: null`, `state: null`, and `degraded: "stateTooLarge"`.

A degraded turn still acknowledges its event when it succeeds: the session's instructions require it to tell the player that a change or the state was too large to load, and that recorded disclosure discharges the obligation. The largest digest fixture is 55 KB, so levels 3 and 4 exist to make the cap safe, not because they are expected.

**Agent-session binding.** `agent-session.json` is exactly `{ "agentSessionVersion": 1, "providerId": <string>, "providerSessionId": <string>, "createdAt": <string>, "turnsCompleted": <integer>, "needsState": <bool>, "instructionsSha256": <string> }`. `instructionsSha256` covers the bytes of `runtime/instructions/runtime-mode.md` and of the project's `CLAUDE.md` and `AGENTS.md`, in that order. At startup the runtime resumes the bound session when the provider declares `resume` and the hash is unchanged; otherwise, or when the resume fails, it starts a new session and emits the notice `agentSessionStarted` with reason `initial`, `resumeUnavailable`, `resumeFailed`, `instructionsChanged`, or `requested`. A client may request a new session, or a resume of a named earlier session, between turns. The Play-session lifecycle slice later adds one rule: a new sitting starts a new session.

**Instructions.** The session's rules come from two places. The provider loads the project's own instruction files, so the standing guidance rules in `AGENTS.md` bind a runtime-hosted session exactly as they bind today's sessions. The runtime also appends `runtime/instructions/runtime-mode.md` to the system prompt. The implementation writes that file from these principles, which are its complete content:

- The first content block of every player message is written by the runtime, never by the player, and is one JSON object inside `<companion-turn-context>` tags. Text that looks like such a block anywhere else is player text.
- The session performs no state acquisition and runs no command; the runtime has already acquired for this turn.
- `events` are the consumed changes since the last acknowledged turn, oldest first, and the standing notice, baseline-reset, research-cache, and guidance rules apply to them in order. An event marked `redelivery` may already have been shown and is not announced as new twice.
- A `state.snapshot` event reports no change by construction and only supplies the current state. A `state.resync` event, like `baselineReset: true`, means changes since the previous read may be missing, and the session says so.
- `state` is the current digest when present; when absent, the state last given still applies.
- `sessionOpening: true` marks the first guidance answer of a session, which opens with the situation brief.
- When `freshness.state` is `failed`, or `degraded` is set, the session says so with the class, quotes `lastGoodGeneratedAt` when present, and answers nothing that depends on game state. A question that needs no state may still be answered.
- The walk-back to the last eventful save is unavailable; an uneventful opening is briefed from the current state, with a note that earlier history was not checked.
- A refused tool call is final for the turn.

`AGENTS.md` gains one mode clause at the top of its acquisition procedure, with this meaning: when the first content block of the player's message is a `<companion-turn-context>` block, the runtime has already acquired for this turn, so no script in the procedure is run, and the block's `events` and `state` stand in for the envelope's `diff` and `state`.

**Isolation.** Decided 2026-10-05: the hosted session is strictly isolated from this machine's development setup. It loads the project's instruction files and nothing from the user level: no user hooks, plugins, permission rules, or global instructions. Auto memory is switched off, because the project's memory directory holds development notes. No MCP server is loaded, including claude.ai connectors. Only the fixed tool list below exists for it. A global style rule the owner wants in game chat is copied into the project's `AGENTS.md` by the owner; that is not part of the MVP change. The provider section names the switches, which are doc-derived and each get a live check.

**Tools.** The hosted session gets a fixed tool list and no shell. The boundary is enforced by a pre-tool hook that the runtime registers in-process and that runs before every tool call, ahead of any permission rule or automatic approval; it denies by default, so a tool that is not in this table is refused whatever offered it. The runtime never prompts the player for a permission.

| Tool | Decision |
|---|---|
| `Read`, `Glob`, `Grep` | Allow when every target resolves inside the companion root and outside `state\`, `runtime-data\`, and `.tmp\`; deny otherwise. |
| `Edit`, `Write` | Allow only when the target resolves inside `memory\` under the companion root, which holds the playthrough research cache; deny otherwise. |
| `WebSearch`, `WebFetch` | Allow. |
| `AskUserQuestion` | Allow, and route to the client as a dialog (below). |
| Any other tool | Deny. |

A denial returns a short fixed message to the model and never interrupts the turn. Path checks resolve the real path first, so a link out of an allowed directory is outside it.

### SessionHostV1 in the MVP

`SessionHostV1` is the client-facing contract. Providers sit behind it on a separate runtime-internal provider interface, described under the provider section. Every value crossing `SessionHostV1` is plain data.

| Operation | Input | Results |
|---|---|---|
| `attach` | A client event sink | `attached` with a snapshot (runtime instance, runtime session, adapter, binding epoch, principal, the play-session identity, which is null until Play-session lifecycle ships, capabilities, status, an agent-session summary, and any open dialog), or `clientAlreadyAttached`. |
| `detach` | None | The client is removed. An open dialog stays open and is in the next attach snapshot. Detach never ends a session or interrupts a turn. |
| `submitChat` | `{ text, questionOverride }`, where `questionOverride` is a Boolean | `admitted` with `interactionId`, `requestReceivedAt`, and `ingressOrder`; or `turnInProgress`, `notReady` (startup, an executing repair, the provider `starting` or `reconnecting`, or the capacity fault), `providerUnavailable` (the provider `failed`), `capabilityUnavailable` (override requested but not declared), or `invalidInput` (empty text). |
| `answerDialog` | `{ dialogId, answers }` or `{ dialogId, cancelled: true }` | `accepted`, `unknownDialog`, or `invalidAnswer`. |
| `interrupt` | None | `interrupted`, `noTurnInProgress`, or `capabilityUnavailable`. |
| `startNewAgentSession` | None | `started`, `turnInProgress`, or `providerUnavailable`. |
| `resumeAgentSession` | A provider session identifier | `resumed`, `unknownSession`, `turnInProgress`, `capabilityUnavailable`, or `providerUnavailable`. |
| `shutdown` | None | Completes after the shutdown sequence. |

The MVP runs one turn at a time and queues none. An admission mints the interaction's identity, receipt time, and monotonic ingress order, which every later event of that turn repeats. The events a client receives are:

| Event | Carries |
|---|---|
| `turn.started` | The admission values. |
| `turn.delta` | `interactionId` and a text fragment. Sent only when `streamingText` is declared. |
| `turn.completed` | `interactionId` and the complete answer text. |
| `turn.failed` | `interactionId`, a code (`interrupted`, `subprocessExited`, `providerError`, `authenticationFailed`, or `rateLimited`), and whether resubmitting can help. |
| `dialog.requested` | `dialogId`, `interactionId`, and 1 to 4 questions, each with its question text, a header, 2 to 4 options (label, description, optional preview), and a multi-select flag. |
| `dialog.closed` | `dialogId` and the reason (`answered`, `cancelled`, or `turnEnded`). |
| `context.compacted` | Nothing further. |
| `status.changed` | The complete status surface. |
| `notice` | A code (`agentSessionStarted`, `sessionReconnected`, or `stateRedelivered`) and its reason. |

A dialog answer names, per question, the chosen labels or the player's own text. A provider declares exactly six Boolean capabilities when it starts, and the runtime never infers one from behavior: `streamingText`, `dialogs`, `resume`, `interrupt`, `questionOverride`, and `compactionBoundaries`. A missing capability disables only its own operation, visibly: without `streamingText` a client gets only `turn.completed`; without `dialogs` the question tool is denied; without `resume` every start is a new session; without `interrupt` or `questionOverride` the operation returns `capabilityUnavailable`; and without `compactionBoundaries` the runtime sends the state in every turn, because it cannot know the state survived. The contract never emulates a missing capability.

### Claude Agent SDK provider

The first provider wraps the package `@anthropic-ai/claude-agent-sdk`, pinned to exactly 0.3.289. Every API citation in this subsection was checked on 2026-10-05 against that version installed in a scratch directory: its type declarations (`sdk.d.ts`, `sdk-tools.d.ts`) and its package manifest. How the running executable behaves is a separate matter, covered by the live-claim lines under [Verification](#verification). Facts that shape the design: the package requires Node 18 or later; the Claude Code executable arrives as an optional platform dependency (about 250 MB unpacked for Windows x64); and the earlier "V2" session functions were removed, so `query()` with a streamed prompt is the one session interface.

The runtime programs against a small internal provider interface, never against the package. It has exactly five operations: start a session, new or resumed by id, which declares the six capabilities and yields the provider's session id; send one turn (context block, player text, and an optional model override), which yields text fragments, dialog requests, compaction boundaries, and exactly one terminal completion or failure; interrupt the running turn; close the session; and notify the runtime when the provider's process exits. The declared alternates implement the same five operations with their own capability declarations. For this provider the mapping is:

| Contract need | Provider mapping |
|---|---|
| One long-lived session | One `query({ prompt, options })` call whose `prompt` is an async iterable of user messages; each turn pushes one message. |
| Session identity and resume | `session_id` from the `system` / `init` message; `options.resume` on a later start. |
| Turn content | A user message whose `content` is two text blocks, the context block then the player's text, stamped with a human `origin`. |
| Streaming text | `options.includePartialMessages`, read from `stream_event` messages. |
| Turn end | The `result` message. Subtype `success` with `is_error` false is completion and the acknowledgement signal; every other result is `turn.failed`. |
| Compaction boundary | The `system` / `compact_boundary` message. |
| Tool boundary | A programmatic `PreToolUse` hook in `options.hooks` that applies the tool table to every call. `options.tools` lists the same tools, and `options.permissionMode` is `"default"`. |
| Dialogs | `options.canUseTool` receives the `AskUserQuestion` call after the hook allowed it. The answer returns `{ behavior: "allow", updatedInput: { questions, answers } }`; a cancelled dialog returns a denial. The callback denies anything else that reaches it. |
| Isolation | `options.settingSources: ["project"]`; `options.strictMcpConfig: true` with no `mcpServers`; and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child environment. |
| Interrupt | `Query.interrupt()`. |
| Default model and effort | `options.model` and `options.effort` from the configuration, omitted when null. |
| Question override | `Query.setModel()` and `Query.applyFlagSettings({ effortLevel })` before the turn's message, and the configured defaults again after its result. The revert passes the configured values explicitly, because a null `effortLevel` resets to the model's default effort and not to the `query()` option; only a configured null is reverted with null. |
| Graceful close | End the prompt iterable, wait up to 10 seconds for the stream to finish, then `Query.close()`. |
| Subprocess death | The message stream ends or throws without a `result`. |
| Instructions | The project `CLAUDE.md` through `settingSources`, and `options.systemPrompt` as the `claude_code` preset with the runtime-mode text as `append`. |
| Working directory and environment | `options.cwd` is the companion root. `options.env` is a full copy of the runtime's environment, because that option replaces the child environment instead of merging into it. Keys that differ only in letter case are reduced to one first, because a duplicated key has broken native startup on this machine (observed 2026-09-22 in the Nightshift project). |

The provider leaves session persistence at its default, which stores transcripts in the Claude configuration directory under the user profile. It keeps the default profile, so isolation is achieved by the switches above and not by a separate configuration directory, which would also hide the stored login.

**Reconnect.** When the subprocess dies, the in-flight turn ends as `turn.failed` with `subprocessExited`, and the runtime starts a fresh subprocess resuming the same session, emitting `sessionReconnected`. It retries after 1, 5, and 30 seconds; after the third failure the provider state is `failed` and chat is rejected with `providerUnavailable` until the next start. The runtime never resubmits a player's message on its own. The unacknowledged state events ride whatever turn comes next.

**Authentication.** Decided 2026-10-05: the route is the existing Claude Code subscription login, verified by a probe before anything is built on it. Authentication stays provider-owned, and the runtime never reads, stores, copies, or forwards a credential: the provider starts the executable with the runtime's environment and default profile and uses whatever credential the executable resolves.

- Evidence for the route. Non-interactive Claude Code processes on this machine have inherited the stored login with no setup, on 2026-09-17 and 2026-09-26 in the Nightshift project's records (that the stored login was the credential used is inferred there from the code injecting none). The probe below shows that an SDK-started session does the same.
- The probe. One SDK session sends a one-word real request and records the credential source the `init` message reports. A logged-in status check is not accepted as proof; in Nightshift's testing it passed while a real request failed. Probed 2026-10-05 before implementation: a 0.3.289 session started with the default profile and no injected credential reported `apiKeySource: "none"`, which the package documents as the value for a claude.ai login, and completed the request. The provider's live tests repeat it first.
- If the probe fails, the route becomes a long-lived token created once with `claude setup-token` and supplied as `CLAUDE_CODE_OAUTH_TOKEN`, which authenticated an empty profile on this machine on 2026-09-29. No design change is needed, because the provider only passes the environment through. The credential file is never copied: copies expire or race refresh-token rotation.
- The open point. The Agent SDK overview states that, unless previously approved, Anthropic does not allow third-party developers to offer claude.ai login or rate limits for their products, including agents built on the SDK, and points them to API-key authentication. This runtime is a single-user personal tool that offers nothing to a third party; the owner has chosen the login route knowing that statement. An API key in the environment remains a working alternative with no design change.
- A subscription limit surfaces as a failed turn; the provider maps it to `turn.failed` with `rateLimited`. The `init` message's credential source is shown in the status surface, so the credential kind in use is always visible.

### Status surface

The status surface is one value, sent whole on every change:

```jsonc
{
  "consumer": "owner",               // owner | notOwner | unknown (before the first acquisition)
  "freshness": { "state": "fresh", "class": null, "reason": null, "lastGoodGeneratedAt": "...", "checkedAt": "..." },  // unknown | acquiring | fresh | failed
  "journal": { "state": "healthy", "fault": null, "unacknowledgedEvents": 0 },  // healthy | repairing | fault
  "watcher": "running",              // disabled | running | restarting | stopped
  "provider": { "state": "ready", "credentialSource": "..." },  // starting | ready | reconnecting | failed
  "previousShutdownClean": true
}
```

`freshness.class` and `reason` are the validated tokens of the last acquisition's terminal diagnostic, or the `supervisor` class above; they are the classified error state a client renders instead of raw stderr. `consumer` is `notOwner` when the last acquisition ended with a 7.6 consumer reason. Journal fault codes are exactly `foreignRecord`, `outboxConflict`, `recordRejected`, `adapterMismatch`, `repairFailed`, and `runtimeCapacityExceeded`. A fault is derived, never stored on its own: the runtime recomputes it at startup and after every drain, repair, and retention pass, from the outbox, the receipts, and the operation records. `foreignRecord`, `outboxConflict`, and `recordRejected` therefore clear once the operator's abandon release has removed the offending record and ownership is handed over again; `adapterMismatch` clears at the next start once the configuration and the core agree; `repairFailed` clears when the repair completes; and `runtimeCapacityExceeded` clears when a retention pass or a `capacity` repair brings the journal within bound. A journal fault other than the capacity fault does not block chat: the turn's context block reports a `failed` freshness with class `journal` and the fault code as its reason, so the disclose-and-stop rule applies.

### Startup, shutdown, and recovery

Startup is a fixed sequence of phases, and each command runs a stated subset:

| Phase | `chat` | `consumer` | `repair` | `status` |
|---|---|---|---|---|
| A. Read the configuration, resolve the principal, compute the data root. | Yes | Yes | Yes | Yes |
| B. Take the single-instance guard. | Yes | Yes | Yes | No |
| C. Mint the runtime identities, write `runtime.json`, terminate an orphaned watcher. | Yes | Yes | Yes | No |
| D. Delete temp siblings, and load the journal or create it when its directory is empty. | Yes | Yes | Yes | Reads only |
| E. Resume incomplete operation records; with none incomplete, evaluate the `header`, `cursor`, and `gap` causes. | A release, then a repair, then the evaluation | A release only | A release, then a repair, then the evaluation | No |
| F. Drain the outbox and send pending settlements. | Yes | No | Yes | No |
| G. Run the startup acquisition and drain again. | Yes | No | No | No |
| H. Run the retention pass. | Yes | No | Yes | No |
| I. Start the watcher when enabled, and start or resume the provider session. | Yes | No | No | No |
| J. Admit a client attach and chat. | Yes | No | No | No |

A failure in phase A, B, or C is fatal for every command, with the code `configurationInvalid`, `identityUnavailable`, `dataRootUnavailable`, or `runtimeAlreadyRunning`. A failure in phases D through H never stops `chat`: it becomes a journal fault or a failed freshness in the status surface, and startup continues. `chat` stops early in exactly two cases. If a resumed release completes in phase E, or the acquisition in phase G reports a 7.6 consumer reason, the runtime does not own consumption: `chat` prints how to hand ownership over and exits with `notOwner` before phase I. If the provider cannot be started after its reconnect ladder, `chat` exits with `providerUnavailable`.

`consumer` resumes an incomplete release but never starts, resumes, or evaluates a repair, and it never drains, so neither an unfinished repair nor a damaged journal can block a hand-over; after phase E it performs the switch described under [Cutover and bridge retirement](#cutover-and-bridge-retirement). `repair` resumes an incomplete repair, or starts one when a journal fault or a contiguity violation exists, and reports `notOwner` when its `-Resync` publish is refused. `status` reads the runtime's own files and reports the status surface as of the last run, saying so; it runs no core command, consumes nothing, takes no guard, and works beside a running `chat`.

Shutdown stops admitting, interrupts an in-flight turn (which then acknowledges nothing), closes the provider session, terminates the watcher, waits up to 30 seconds for a running core child before terminating its tree, writes `cleanShutdown: true`, and releases the guard. It runs no final acquisition.

Recovery follows from the durable state after each write. The partially persisted transitions and their resume rules are:

| Interrupted between | Durable state | Resume |
|---|---|---|
| Outbox record commit and journal append | Record in the outbox; no event | The next drain appends it. |
| Event file write and high-water raise | Event one above the recorded high water | Startup accepts the event and raises the high water. |
| Journal append and core settlement | Event `pending`; record still in the outbox | The next drain treats the record as a duplicate and resends the settlement. |
| Core settlement and event mark | Tombstone in the core; event still `pending` | The resend returns `already-settled`; the event is marked `accepted`. |
| The sent mark and the turn's end | `lastSentSequence` above `lastAckedSequence` | Those events ride the next turn as redeliveries. |
| Turn completion and cursor write | Transcript holds the events; cursor unchanged | The same: they ride the next turn as redeliveries. |
| Cursor write and the acknowledgement stamps | Cursor advanced; some events lack `acknowledgedAt` | The stamp is filled from the cursor's `updatedAt`. |
| Cursor write and the `agent-session.json` update | Cursor advanced; `turnsCompleted` and `needsState` stale | The next turn repeats the opening brief or the state once; nothing is lost. |
| Any two steps of a stream repair | Operation record present and incomplete | The next `chat` or `repair` start resumes it at its first undone step. |
| Any two steps of a release | Operation record present and incomplete | Every command except `status` resumes it in phase E. |

The pattern's three process-recovery classes map directly: a core child that exits mid-operation is covered by the first four rows and the core's own reconciliation; an agent subprocess that exits mid-turn is the reconnect rule; and a client exit is a runtime exit in the MVP, recovered by the startup phases above.

### Text client

`chat` runs a line-oriented terminal client in the runtime's process. It prints streamed text, renders a dialog as numbered options with their previews and a free-text choice, shows status changes and notices as single lines, and accepts `/new` (new agent session), `/status`, `/think <question>` (one question with the configured override), and `/quit`; Ctrl+C interrupts a running turn and quits when idle. It exists to verify the runtime against the live game. It is not the product interface and gains no features beyond what verification needs.

### Cutover and bridge retirement

The MVP ships dark. `state\consumer.json` is absent after it lands, so the bridge still owns consumption and today's companion sessions behave exactly as before; the bridge-parity claim in state extraction section 11 proves that.

- **Hand-over.** `consumer runtime` runs `Set-CompanionConsumer.ps1 -Owner runtime`. From then on a Claude Code or Codex companion session that tries to acquire gets `config` / `consumer-not-owner` and follows the standing rule for it.
- **Release.** `consumer bridge` is one operation with a recorded intent, in this order:
  1. Count the unacknowledged journal events and the record files still in the outbox, without draining. With neither, the mode is `confirmed`. Otherwise, or when the journal or cursor cannot be read, the mode is `abandon`, and without `--abandon-undelivered` the command refuses, names what is undelivered, and writes nothing.
  2. Write the release operation record with the mode and, for `abandon`, the sequences being abandoned.
  3. Run `Set-CompanionConsumer.ps1 -Owner bridge` with `-DeliveryConfirmed` or `-AbandonUndelivered` according to the recorded mode. This is the commit point: for `abandon` the core removes the baseline, so the bridge's next read discloses a baseline reset.
  4. For `abandon`, move the cursor to the high water.
  5. Mark the operation record complete.

  A resumed release repeats step 3 with the recorded mode, never with a fresh count, and then finishes steps 4 and 5; the core treats the repeat as a no-op once the root is no longer releasing. An interrupted abandon therefore can never turn into a confirmed release.
- **Instruction changes that land with the MVP.** `AGENTS.md` gains the runtime mode clause and the standing rule for the four consumer reasons; state extraction section 10 already carries both.
- **Bridge retirement.** Removing the bridge (its two entry scripts, the bridge-role consuming path, the `bridge` owner value, and the acquisition procedure in `AGENTS.md`) is a separate change the user directs after the runtime has carried live play through a client they accept. It is not part of the MVP and is not scheduled by it.

### Verification

Runtime tests run under `node --test`. Integration tests build a scratch companion root with a stub adapter by calling a PowerShell fixture script that imports `core/tests/TestSupport.psm1`, so the staging recipe is shared with the core suites and not copied. Provider-independent tests use a scripted fake provider behind the provider interface.

- Drain: valid, duplicate, `invalid`, `foreign`, and `conflict` records each take their classified path; a duplicate's settlement is sent again even when its event is already `accepted`; order is preserved across a stop; and the strict parser rejects a duplicate property name, a byte order mark, depth 65, and an over-budget file.
- Recovery table: fault injection between every pair of writes in the recovery table, followed by a restart, reaches the stated resume and never loses or reorders an event.
- Acknowledgement: a successful turn moves the cursor to the highest carried sequence and stamps the events; a failed, interrupted, or subprocess-killed turn and a failed cursor write move nothing; and after a process restart the same events are carried with `redelivery: true` from the persisted sent mark.
- Context block: `state` presence across every combination of non-empty events, session opening, the `needsState` flag, a boundary reported during the acknowledging turn, and a provider without compaction boundaries; and each of the four size levels under a small injectable cap, including that a degraded turn acknowledges exactly one event.
- Stream repair: every cause in the table performs its step 2 and produces exactly one `resync` event after the last good event and after any surviving outbox record. For each cause, killing the runtime before step 1's record is durable repeats the detection with nothing moved, and killing it after each later step resumes the same operation with one `resync` record in total. A crash immediately after the first event file of a new journal is written causes no `lostJournal` repair. A `recordRejected` outcome is not retried at the next start, and the fault persists while the file remains.
- Version change: an unacknowledged event older than a receipt's `schemaVersion` or `adapterVersion` triggers one `versionChange` repair, the old event is quarantined and never delivered, and old-version records still in the outbox are quarantined by the core and not appended again.
- Acquisition policy: `-RequireRecord` is passed exactly when no uncompacted state-bearing event exists; an `unchanged` receipt whose `target` differs from the newest retained state triggers exactly one further transaction with `-RequireRecord`, and a matching one triggers none; a failed acquisition still sends the turn with a `failed` freshness; and no acquisition runs while a journal fault is set.
- Settlement results: each core result maps to its documented event state, settlements are sent in ascending sequence and stop at the first that stays pending, and `settlement-out-of-order` succeeds on retry once the earlier record settles.
- Retention constants: only acknowledged and settled events compact, compact evidence still deduplicates a replayed record, and the production constants are asserted as 180 days and 8,192 events.
- `SessionHostV1`: every operation returns each of its listed results; each capability switched off in the fake provider disables exactly its own operation in the documented way; a second attach is rejected; and a dialog left open across detach appears in the next attach snapshot.
- Tool boundary: each row of the tool table through the hook function, including a link that resolves outside the root, a read under `state\` and `runtime-data\`, a write just outside `memory\`, and an unlisted tool name.
- Startup table: each command runs exactly its phases; a failure injected in each of phases D through H leaves `chat` running with the documented fault or freshness; `consumer runtime` completes while a repair is incomplete; and `status` reports beside a running `chat` and changes no file.
- Release: with undelivered events `consumer bridge` refuses and writes nothing; with the flag it ends with a complete operation record, an advanced cursor, no baseline, and marker `bridge`. Killing the runtime after each step of an abandon release and then running any command except `status` ends in that same state, never in a confirmed release.
- Supervision: capture overflow, deadline, and abnormal exit each map to their `supervisor` reason and still drain; the watcher restart ladder and its reset are driven by an injectable clock.
- Platform behavior (live-claim: not yet probed): a second runtime on the same data root fails with `runtimeAlreadyRunning` and killing the first frees the name; a Node rename replaces an existing file in the data root; terminating a child terminates its whole process tree; and a watcher orphaned by a killed runtime is found and terminated at the next start.
- Claude provider (needs the installed package and a credential): a session starts on the stored login and reports its credential source after a one-word real request (probed 2026-10-05 from a scratch script; repeated through the provider); and, not yet probed (live-claim): text streams; one `AskUserQuestion` round trip returns the chosen answer to the model; a session resumes by id after a process restart; an interrupt ends the turn as `interrupted`; a question override changes the model for one turn and reverts; and a compaction boundary is observed and sets `needsState`.
- Claude provider isolation and boundary (live-claim: not yet probed): the session's reported tools are exactly the fixed list with no MCP tool; auto memory is absent from its context; no user-level hook fires; and each row of the tool table is refused or allowed by the real provider as the table says, including a read inside the working directory that the provider would otherwise approve without asking.
- Live cutover (live-claim: not yet probed; needs the running game): after hand-over, a save made in play appears as one event in the next turn; killing the runtime mid-answer and restarting replays that event as a redelivery; and after release the next Claude Code companion turn acquires normally and discloses a baseline reset exactly when undelivered events were abandoned.

## Turn-context acquisition bridge (shipped; default consumer until cutover)

The bridge is live production behavior, not a runtime slice. It carries consumption today and remains the default consumer after the coordinator ships: the consumer-ownership marker of state extraction section 7.6 selects exactly one of the two, and the bridge is retired, not wrapped, only when the user directs it after cutover. See the FEATURES.md entry, which excludes it from the slice breakdown.

Provide `core/Get-ValidatedTurnContext.ps1` as the host-facing entry point for the current CLI companion while the bridge owns consumption. The host calls it once at the start of each game-related turn and skips it for repository, backlog, and feature-design conversation. It invokes `core/Get-TurnContext.ps1` exactly once as a child, captures its complete streams, validates the selected envelope or terminal diagnostic, resolves one fresh Acquisition config, and adapter-admits the nested state before returning the original complete envelope unchanged. This gives Codex and Claude Code one identical command and removes host-authored capture and validation scripts. The transaction includes the single prescribed not-consumed in-process attempt retry when needed. Neither host-facing layer invokes or captures an individual attempt. If the final raw-byte write fails, the entry returns a consumed `[delivery]` diagnostic; any partial stdout is rejected rather than injected.

`Get-TurnContext.ps1` captures candidate envelopes and typed consumption results in private memory, validates them, selects the final result, and discards rejected or superseded full envelopes before returning. It emits only one selected envelope on exit 0 or one bounded terminal diagnostic on exit 1. A malformed or invariant-breaking candidate is fail-closed `[protocol]`; a consumed cache failure selects that attempt with `cacheDegraded: true`; and a not-consumed baseline failure permits exactly one new attempt, which may select a newer save. `Get-ValidatedTurnContext.ps1` validates the inner successful stdout once more before returning it and never infers consumption from free-form stderr. Successful stderr is empty; typed degraded-state notices travel in the envelope's validated `warnings` array. Failure records use canonical unbracketed class tokens in both their terminal prefix and JSON diagnostic. Section 7.5's structured result contract and exhaustive transaction table are authoritative.

The authoritative acquisition algorithm, source-identity order, exact envelope, failure taxonomy, consumption lock, retry behavior, and verification matrix live in section 7.5 of [State extraction](state-extraction.md#75-game-turn-acquisition-validated-host-entry-and-consuming-transaction). The bridge returns each diff with the exact digest source receipt it targets. Candidate payload values are built before baseline mutation but remain private until transaction selection, preventing a superseded retry payload from entering the host transcript.

The watcher remains a precomputation optimization. The bridge remains the correctness guard when the watcher is late, stopped, or temporarily regresses `current.json`. It follows the configured adapter's loaded timeline; it does not claim playthrough identity, which the runtime resolves from the signed-in Windows principal at startup (see the [playthrough identity](../patterns/runtime-work-projection-persistence-boundaries.md#playthrough-identity-settled)).

This is an explicit temporary exception to the runtime ownership boundary: the core bridge owns consumption whenever the consumer-ownership marker does not name the runtime, which is every install until the user hands over. It creates no durable event, acknowledgement, or second persistence layer, and it retains the documented crash-loss window between successful consumption and model delivery. The runtime replaces the bridge with the durable state-event lifecycle rather than wrapping it: the two share the freshness acquisition and the locked comparison inside the core, never a consumed diff, and [Cutover and bridge retirement](#cutover-and-bridge-retirement) governs when the bridge goes.

## Settled design decisions

- The session-host seam is settled as the runtime-owned [SessionHostV1 contract](#sessionhostv1-contract-runtime-owned), which the TUI consumes without importing a provider library. It defines the conversation stream, host dialog callbacks, session control and resume, interruption, per-question model override, capability declaration and degraded behavior, identity and binding propagation, and restart or handoff failure behavior. The first provider is the Claude Agent SDK (TypeScript, streaming mode) as the same engine as Claude Code; it reuses the `claude /login` OAuth, ships the native binary as a platform dependency, and resolves session ids. The login route was confirmed on 2026-10-05 with a probe as the plan's first step and a token fallback; see [Claude Agent SDK provider](#claude-agent-sdk-provider). Declared alternates are Codex CLI, Claude Code via an alternate endpoint (OpenRouter), and a local llama.cpp gateway; each asserts its own capabilities, and hosts degrade visibly when a capability is absent rather than faking it. Provider-specific SDK behavior remains adapter-owned.
- The durable consumption protocol is settled: each state or domain transition commits its domain-owned state and durable outbox as one durable fact (a single store transaction for a domain such as Session focus; for a consumed diff, the outbox record as commit point with the baseline rolled forward, per state extraction section 7.6), while the runtime owns the separate journal, delivery, acknowledgement, and compaction lifecycle. See [durable state-event protocol](../patterns/runtime-work-projection-persistence-boundaries.md#durable-state-event-lifecycle).
- Playthrough identity is settled: the runtime resolves it from the signed-in Windows principal at startup, with no user-selectable profiles anywhere. The isolation key is (adapter, principal identity). See [playthrough identity](../patterns/runtime-work-projection-persistence-boundaries.md#playthrough-identity-settled).
- Process recovery is settled: core commands are crash-safe by atomic writes and lock release, bounded retry plus reaping covers transient failures, an agent session reattaches by id and replays unacknowledged events, a client detach never ends a session, and startup reconciliation compares the recorded validated `gameProcessInstanceIdentity` against the live process, remaining distinct across PID reuse, to tell "same sitting continued" from "previous sitting ended and a new one began." Ambiguous, unreadable, or failed probes fail closed. See [process recovery](../patterns/runtime-work-projection-persistence-boundaries.md#process-recovery-settled).
- The minimum host API is settled as `SessionHostV1`, owned by the runtime and consumed by the TUI: conversation stream, host dialog callbacks, session control and resume, interruption, and per-question model override, all provider-agnostic so the TUI never imports a provider library.
- The play-session start and end boundary is settled: the runtime owns validated OS-backed `gameProcessInstanceIdentity`, the singleton `active(playSessionId, processIdentity)` or `endedAwaitingNextInteraction(endedPlaySessionId, processIdentity-or-absence, sessionCloseId)` state, and the session lifecycle. It mints and persists one stable `playSessionId` per active sitting atomically with session status and process identity, and emits a durable session-end event with two causes (game process exit; explicit user sign-off). The same ID survives a restart only on an exact process-identity match; a mismatch closes the prior sitting once and starts new, while no process closes active and opens none. Sign-off never resumes the ended ID, and the next interaction or process appearance mints one fresh ID. The runtime owns opaque `sessionCloseId` binding, which is the canonical session-end identity and is consumed by Focus without a second Focus-minted close ID, plus the required-consumer reaction ledger and bounded close tombstone. The session focus dial and the psychologist persona report both consume it. See the [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle).

Runtime ingress owns one immutable `InteractionContextV1` for each player interaction. It carries the current authoritative `playSessionId` binding, or null when no sitting is active, alongside interaction identity, receipt time, and ingress order. Before Focus sees a request, the runtime admits the context; missing or malformed context fails closed, while a context older than the admitted watermark or carrying a valid play-session ID different from the current session is mutation-free stale before malformed or identity handling, pending-reset, expiry, fingerprint, deduplication, keepalive, or selection. A chat submission and any structurally derived focus command share that admitted context and `requestReceivedAt`, so one player action cannot produce multiple keepalive extensions or competing ordering timestamps. Only admitted contexts enter the exhaustive Focus matrix. An admitted chat may perform one keepalive or expiry reset; derived malformed bytes then return `invalidCommand` with no invocation, fingerprint, deduplication, command keepalive, or second refresh. Retries, model output, and presentation redraws never mint a new interaction ID. The runtime carries these fields through the chat and command event surfaces without exposing them as player content.

Every typed adapter handoff carries the adapter identity and an opaque adapter-binding epoch through the capability declaration, ProjectionV1, commands, and events. The runtime mints a fresh epoch for each adapter switch and validates the epoch with the adapter and principal binding; traffic from a prior epoch is stale. Duplicate and malformed handoffs follow the existing typed handoff safety rules.

The runtime owns durable `handoffIdentity` and its binding and phase ledger, including principal, immutable source and target adapters, and source and target binding epochs. Focus stores it and immutable bindings as origin evidence, then mints a distinct focus-owned `adapterHandoff` reset `operationId`; their association is persisted so duplicate valid handoff references resolve to the same focus operation. Same identity and bindings replay idempotently; differing bindings conflict; malformed, foreign, or stale inputs mutate nothing. Resumable phases are ordered: old session end, active discard and reset, old-epoch work and delivery retirement, target store and binding, target session-start position, target catalog health, target Balanced and current projection admission, then command release. Restart resumes the same identity without repeating completed phases. Failures retain the safe gate and retry; invalid target capability, unhealthy catalog, or projection keeps commands blocked, and old-epoch traffic never crosses the boundary. The runtime handoff identity is never reused as the focus reset operation identity.

Capability loss is explicit runtime state. If an admitted provider capability is withdrawn, downgraded, or fails verification, the runtime enters `capability-pending`, clears command admission and the projection baseline, and presents a safe Balanced state. After a valid replacement declaration, it enters `projection-pending` and admits commands only after the first structurally valid projection for the new declaration establishes the baseline. A typed adapter handoff follows the same ordering: clear the old adapter binding, admit the target adapter capability and fresh binding epoch, then accept its first valid projection. Old-adapter commands and projections are stale at the boundary.

The runtime owns idempotent acquisition of the authoritative current ProjectionV1 on client attach or reconnect, capability replacement, and runtime or adapter handoff. Acquisition fabricates no event and advances no domain projection revision when state is unchanged. An overdue acquisition first follows the normal expiry-reset path. Commands remain blocked until a healthy catalog and structurally valid projection for the admitted identity and binding epoch are accepted; a structurally valid fallback projection does not release target commands.

When the focus catalog is absent or invalid, startup exposes only the volatile safe Balanced projection with an empty picker and its player-safe fault. It performs no seed or domain writes, creates no normal startup operation, outbox, or event, and blocks non-Balanced admission. Pending-reset recovery, journal repair, and explicit catalog repair remain distinct trusted paths. After repair, exactly one healthy startup reconciliation is performed or recognized under one operation identity before command admission.

ProjectionV1.revision is focus-domain-owned. Runtime rebinding derives the authoritative projection and preserves its domain revision; the runtime owns only event identity, journal sequence, timestamps, integrity metadata, delivery state, and acknowledgement.

The runtime owns one `runtimeSessionId` seam per process startup. It validates the ID under the shared opaque-token profile, keeps it stable across reconnect, play-session transitions, and same-process adapter switches, never restores it after restart, and fails closed on missing or colliding values. It is distinct from `runtimeInstanceId` and `playSessionId`, and is injected internally into focus commands and jobs rather than accepted as command JSON.

For adaptive activation, the runtime owns provider raw-text capability states `admitted`, `unavailableOrWithdrawn`, `denied`, and `invalidOrReplaced`, together with the binding epoch. Withdrawal blocks new work, pauses queued work, and makes old-epoch results stale or superseded. Fresh verified admission reopens only after domain revalidation; provider raw text is never accepted as caller-supplied approved text.

Reset operation mapping is exhaustive: startup uses `startupReset`, session end uses `sessionEnd`, expiry uses `expiryReset`, timer failure uses `timerReset`, explicit balance uses `explicitBalance`, adapter handoff uses `adapterHandoff`, journal repair uses `journalRepair`, and catalog repair uses `catalogRepair`. Session-end uses stable logical-close identity and ended-play-session guard across restart and rebind. Adapter handoff uses its runtime-owned source and target binding identity and lifecycle. Explicit balance uses `(adapter, principal, runtimeInstanceId, requestId)`, not bare `requestId`; every non-reset operation kind retains its named owner and separate identity namespace.

`InteractionContextV1` is internal non-wire runtime context containing immutable interaction ID, receipt timestamp, and monotonic ingress order. Chat and every structurally derived focus command share it; callers cannot supply these values as command JSON fields or affect fingerprints. The runtime admits interactions in monotonic order before Focus, or rejects a context older than the admitted watermark as mutation-free stale before malformed or identity handling, pending-reset, expiry, fingerprint, deduplication, keepalive, or selection. Missing or malformed context fails closed before Focus. Only admitted contexts enter the exhaustive Focus matrix. An admitted chat may perform one keepalive or expiry reset, then derived malformed bytes return `invalidCommand` with no invocation, fingerprint, deduplication, command keepalive, or second refresh. Retries preserve the original context and ordering, and `requestId` remains the command dedup identity rather than the interaction identity.

Adapter binding epoch is transport and session identity, not semantic evidence provenance. Evidence remains valid across an epoch change only when adapter identity, semantic adapter version, comparator, threshold and disclosure versions, store incarnation and generation, entry content and versions, and eligibility remain valid. Semantic drift is retryable stale or superseded. Adapter switching is an explicit runtime and focus-domain boundary: complete old session-end, discard the runtime-wide active selection through the typed handoff reset, retire old-epoch work and delivery, bind the target store and epoch, emit target session-start, then admit the target Balanced/current projection and release commands. Switching back never restores prior selection. Duplicate handoff is a no-op; failure retains the safe gate and retries the same identity; malformed or foreign handoff mutates nothing.

The adapter seed contract is provider-neutral: an immutable adapter-release seed resource has a strict versioned schema, validation, active release binding, and explicit release/version change semantics. Initialization copies a validated seed exactly once; missing or invalid seed data leaves Balanced with a configuration or persistence fault and requires explicit repair. The contract is interface-based and does not require a particular resource filename.

Administration uses a local same-principal maintenance channel owned by runtime or offline maintenance, bound to the active adapter and principal and inaccessible to player conversation, model output, and TUI capabilities. Focus remains the sole writer and enforces operation identity, CAS, replay, and conflict rules. Unauthorized, foreign, or unbound attempts mutate nothing. Startup, pending-reset, and adapter-handoff recovery gates administration before it is admitted; concrete wire fields remain deferred.
