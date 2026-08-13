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

## Projection boundary

Internal knowledge, raw source material, unseen graph relationships, and
unprojected task results never cross into prompt assembly, notifications, inbox
views, objective boards, or logs visible to the player. Every player-facing
consumer accepts projected records rather than filtering raw records itself.

Broader spoiler modes change the projector policy. They do not grant direct UI
access to the internal store.
