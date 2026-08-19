# Runtime work, projection, and persistence boundaries

Use this pattern wherever state changes trigger work that may outlive one model
turn or presentation process. It prevents the runtime, domain, and UI layers from
becoming competing writers and keeps internal knowledge away from player-facing
surfaces.

## Ownership

| Concern | Owner |
|---|---|
| Save detection, digest production, baseline correctness | State-extraction core |
| Diff consumption, durable state-event handoff, process and worker lifecycle | Execution runtime |
| Work selection, priority, visibility, and domain record transitions | Domain feature |
| Spoiler projection and player-safe result content | Domain disclosure service |
| Rendering, navigation, and user commands | Presentation client |

Every mutation has one owner. A presentation client may request that a result be
consumed, but the domain service performs and persists the transition. A domain
scheduler may request execution, but the runtime owns the attempt, retry, and
cancellation machinery.

## Work visibility classes

- **Response notice:** player-visible information caused by a known state change.
  It appears before ordinary guidance and is not an inbox task.
- **Hidden enrichment:** automatic research or recomputation. It never appears in
  the inbox, including while queued, retrying, or blocked offline.
- **User-visible deferred task:** work the user explicitly asked to receive later.
  It may appear as queued, researching, ready, and consumed.

Visibility is assigned by the domain when work is created and is never inferred
from duration, worker type, retry count, or result size.

## Durable state-event lifecycle

Creation:

- The runtime creates a durable event for the consumed diff before, or atomically
  with, advancing the state that marks that diff consumed.
- The event records adapter identity, playthrough identity, source and target
  state generations, schema and adapter versions, creation time, and payload
  integrity metadata.

Consumer transaction coupling (settled protocol):

- The consume transaction is the single commit point. Inside one `consume.lock`
  critical section, the core appends the durable event record to the journal and
  advances baseline to the target using atomic temp-then-rename writes, so both
  mutations commit or neither does. Baseline advance is the outbox commit:
  "consumed" and "replayable" are one fact, not two that can disagree.
- A crash inside the transaction leaves either state absent entirely (no event,
  no advance, clean re-consume of the same target) or present entirely (event
  durable, baseline advanced then replayed at startup). A torn intermediate is
  structurally impossible, so the documented crash-loss window between
  consumption and model delivery closes.
- Replay order is source-receipt order; a source receipt is replayed at most
  once. Later save changes create later ordered events and never overwrite an
  unacknowledged predecessor.
- Single-writer reconciliation: the core creates event rows inside its own
  consume transaction; the runtime is the sole writer of everything that
  happens to an event after creation (acknowledgement, replay, compaction).
  One writer per concern, with the commit point owned by the core.

Refresh:

- Later save changes create later ordered events. They do not overwrite an
  unacknowledged predecessor.
- Walk-back enrichment may annotate the event used for a landing brief, but it
  does not change which diff was consumed.

Acknowledgement and replay:

- Delivery is acknowledged only after a spoiler-projected notice or brief is
  durably retained by the active session or confirmed presented by the client.
- Startup replays unacknowledged events in order before treating newer ordinary
  guidance as current.

Invalidation and retention:

- Schema or adapter-version incompatibility prevents projection and reports a
  recoverable stale state; it never converts the event to acknowledged.
- A reload rewind creates an explicit later event. It does not rewrite history
  to make earlier forward progress appear current.
- Acknowledged events may be compacted according to a retention policy, while
  preserving enough identity and audit metadata to avoid duplicate delivery.

Scope and consumers:

- Journals are isolated by adapter and playthrough.
- The runtime is the sole writer. Domain projectors read events and attach
  derived records; presentation clients receive projected records only.

## Domain work lifecycle

Creation records the triggering state generation, visibility class, domain
purpose, priority, evidence status, and idempotency identity. Refresh supersedes
or recomputes derived results when their inputs change. Cancellation stops future
attempts without claiming the work succeeded. Retry preserves the original work
identity and records each attempt. Completion stores the internal result before
projection. User-visible consumption is a domain transition invoked by a client.

Stale and provisional results remain explicitly marked. A failed probe or worker
run maps to the most cautionary available status, never to clean, complete, or
safe-to-disclose.

## Play-session lifecycle

A play session is one period of companion-engaged play: the boundary the
[session focus](session-focus.md) dial auto-reverts on, the
[psychologist persona](psychologist-persona.md) emits its end-of-session report
on, and the runtime's process lifecycle brackets. The runtime owns the session
boundary and emits one durable session-end event that every domain consumer
reacts to; no feature owns its own session-end detection.

Start:

- A session starts at the first game activity after an end: the adapter's game
  process appears, or the first player interaction after a sign-off. The next
  interaction after a sign-off starts a fresh session with a balanced focus
  dial.

End (composite signal, one event):

- Game process exit (automatic primary): the runtime watches the adapter's game
  process (the adapter declares its process name) and treats exit as the end of
  the session. This is the ground truth for "stopped playing."
- User sign-off (manual): a player-facing "end session" command ends the session
  even while the game is still running. It is a deliberate close, so every
  session-end reaction fires.

The session-end event is a lifecycle event, distinct from consumed-diff events,
and does not depend on the durable-consumption protocol. It records adapter
identity, playthrough identity, the cause (process-exit or sign-off), and start
and end times. A TUI restart never ends a session.

Save-activity quiescence is deliberately NOT a session-end signal. The runtime
derives session ends only from the game process and explicit sign-off. A failure
or absence of process monitoring does not degrade to a heuristic session end; it
is treated as a fault to surface and fix, not as a boundary to guess. A failed
or absent process check maps to the most cautionary status ("no session-end
derived"), never to clean or complete.

Consumers react, never emit: the focus dial reverts to balanced on any-cause
end; the persona queues its report on any-cause end. Startup replays
unacknowledged session-end events in order, per the durable state-event
lifecycle above.

## Playthrough identity (settled)

Playthrough identity is the signed-in Windows principal, resolved by the runtime
from `[Security.Principal.WindowsIdentity]::GetCurrent()` (principal ID and SID)
at startup. It is never user input: the TUI exposes no profile or account
control, and no other presentation surface does either.

The binding follows automatically from the adapter layout: the adapter's
`saveDirectory` lives inside the current user's profile
(`%USERPROFILE%\AppData\LocalLow\...`), so the running principal and the single
save set owned by that principal coincide. One user, one save set, one timeline
per adapter.

Consequences:

- The isolation key for journals, state-event and session-event records, domain
  persistence, agent sessions, and user preferences is (adapter, principal
  identity).
- The instance is single-principal: the runtime runs as whoever owns the saves
  it reads, and there is no identity-switching surface anywhere in the stack.
- Identity resolution is fail-closed: if `WindowsIdentity::GetCurrent()` yields
  no principal or an unexpected context, the runtime denies identity-keyed work
  (no journal event, no session start) and reports the fault. A failed identity
  check is never a clean identity.
- Multiple playthroughs within one user are out of scope. Distinguishing a fresh
  run from a loaded old save remains deliberately un-attempted (state-extraction
  section 12 anti-goal); a later multi-playthrough data question is a domain
  question, not an identity question.

## Process recovery (settled)

The runtime owns process and worker lifecycle, so recovery policy is
runtime-owned. Failures fall into three classes, each with a defined response:

1. **Core command exits mid-operation.** Already crash-safe by construction:
   state files are atomic temp-then-rename writes, the consume transaction
   commits all-or-nothing, and file locks release when the holding process
   dies. Recovery is bounded retry of the non-consume command, work-file
   reaping of orphaned dump/digest `tmp` entries, and classifying a
   consume-lock timeout as transient `busy` rather than a fault. No
   reconstruction is ever needed.
2. **Agent session subprocess exits mid-turn.** The runtime reattaches the
   same session id in a fresh subprocess, replays any unacknowledged state
   events from the journal, and surfaces a "session reconnected" notice. A
   crashed turn may replay once on reconnect; the once-per-source-receipt
   ordering in the consumer coupling is the acknowledgement boundary.
3. **Presentation client exits.** Detach is not a session end. The runtime
   keeps running headless, retains unacknowledged events, and replays them in
   order for the next client attach over the same host seam.

Startup reconciliation of an overlay runtime restart:

- At session start the runtime records the adapter's game process id. On
  startup it checks the game process name and pid:
  - Same pid running: the player kept playing through the downtime; the
    session continues and unacknowledged events replay.
  - Different pid running: the previous sitting ended (process exit) while the
    runtime was down and a new one started; synthesize the old session-end
    event with cause process-exit, then open a fresh session for the new pid.
  - No process running: synthesize session-end on the previous session, no
    phantom-open session; the next game-process appearance starts a new
    session.
- A missing process watch (no process name declared, or the check fails) is
  fail-closed per the play-session lifecycle rule: neither an ended nor an
  ongoing session is invented; the fault surfaces and no session-end or
  session-start is derived from a failed check.

## Projection boundary

Internal knowledge, raw source material, unseen graph relationships, and
unprojected task results never cross into prompt assembly, notifications, inbox
views, objective boards, or logs visible to the player. Every player-facing
consumer accepts projected records rather than filtering raw records itself.

Broader spoiler modes change the projector policy. They do not grant direct UI
access to the internal store.
