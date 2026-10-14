# Features

Product-level feature ideas captured during brainstorming. Each entry points at a standalone file under `.nightshift/features/<slug>.md` with the full design sketch. Check this index before proposing new feature directions in the same territory.

This file is **one of four repo-local indexes** agents consult on demand when relevant (alongside `QUICK_WINS.md`, `BUGS.md`, `PATTERNS.md`). Each entry here is a short paragraph summary plus a `**Requires:**` line, an optional `**External:**` line, and optionally a `**Slices:**` block (formal MVP plus continuations; see `## Slicing` below). For features that are partially done without a formal slice breakdown, describe the partial progress in the entry's own prose; there is no separate marker convention for "partially shipped". The detailed design lives in the linked file. When a feature (or a slice of a sliced feature) ships, append its entry to [`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); do not keep an `## Implemented` section inline.

Backlog prose is one paragraph or one bullet per physical line, never hard-wrapped at a column: a search hit then shows the whole entry, the parsers anchor on whole lines, and an edit shows as one changed line instead of a reflowed block. `/nightshift:ready` reports a hard-wrapped file as a notice and `/nightshift:init-backlog` unwraps it.

## Requires lines

**Every feature index entry carries a `**Requires:**` line** declaring the upstream gates that block the feature. The line is comma-separated and stays on one physical line (the parser joins a wrapped line, but the line discipline above forbids wrapping). Each item is one of two forms:

- A markdown link to a feature, quick win, or bug entry tracked in one of the four indexes. The reference is a current blocker; under the walk-and-remove convention below, a satisfied dependency is edited out of the line at the moment it ships, so `/nightshift:ready` treats every in-backlog reference as actively blocking.
- The literal word `none.` if there are no upstream gates. An empty label is a structural error; `none.` is the only empty form.

Bare text in `**Requires:**` is a structural error. External primitives (an SDK feature, infrastructure capability, library, hardware, a user decision) go on a separate, optional `**External:**` line directly below it, with the same comma-separated grammar: `**External:** vendor SDK 3.0, hardware enclosure.` Absence is its only empty form, so `none.`, an empty label, or a markdown link in it is a structural error (a link parked there would be invisible to the walk-and-remove convention). A link means an item that is entirely a markdown link; prose that merely contains a link is bare text. `/nightshift:ready` classifies a work unit with at least one in-backlog blocker as Blocked with its externals noted parenthetically, and a work unit with externals and no blocker as External. Every structural error names its remedy.

A missing `Requires:` line is a structural error: every entry must say something. Silence is not the same as `none.`; it indicates the dependency review hasn't been done. The `/nightshift:ready` skill parses these lines to compute the unblocked work set.

**After adding a new entry (or a feature breakout file), and after graduating a draft from `## Exploring`, run `/nightshift:ready`** from the repo root so the bundled `skills/ready/ready.js` validates the post-edit backlog. A new entry must parse and its `**Requires:**` line must resolve. A graduation is incomplete until the selected entry is absent from `exploring`, the selected entry or its unshipped slice work units appear in `ready`, `blocked`, or `external`, the selected entry has no structural error or notice, and the transition introduced no new structural error or notice. Surface pre-existing unrelated problems again, but they do not alone block that graduation. A failed parser invocation, missing work index, missing active classification, selected-entry problem, or newly introduced problem stops graduation until corrected and rechecked.

Downstream relationships (this feature **enables** what) are not encoded structurally. They can be derived by walking the upstream graph in reverse, and over-codifying them creates a second source of truth that drifts. Mention downstream relationships in design prose where they aid understanding.

**Carve-outs:** sections like `## Working hypotheses`, `## Staging`, `## Future directions (not yet designed)`, `## Author tooling`, and `## Exploring` describe pre-feature material (orienting prose, shipping order, shallow placeholders, workflow notes, exploratory brainstorms) rather than ready-to-implement entries. Items in those sections do not carry `Requires:` lines (or, in `## Exploring`'s case, may carry them as historical artifacts only). `/nightshift:ready` ignores the bulleted sections entirely and keeps `## Exploring` out of the readiness set, reporting its entries separately as titles-only drafts; `/nightshift:exploring` renders them in full. Working hypotheses / Staging / Future directions (not yet designed) / Author tooling are bulleted rather than `###` headings, so the `###`-only candidate filter handles them naturally; `## Exploring` holds `###` entries, collected as drafts and never classified.

Concrete entry shape inside the index. The example shows a feature link, a quick-win link, and an External line to show both lines; a real entry only includes whatever it actually depends on:

```markdown
### [<Feature name>](features/slug.md)

<Short paragraph summary.>

**Requires:** [other-feature](features/other-feature.md), [shared helper extraction](QUICK_WINS.md#shared-helper-extraction).
**External:** some external primitive.
```

**When a feature is implemented**, move its index entry to [`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); drop its `Requires:` and `External:` lines in the move (history entries don't need them). The feature file stays in place as a historical design record.

**Then walk every other `**Requires:**` line in `FEATURES.md` and `BUGS.md`** and remove references to the just-shipped feature: if it was the only item on the line, set the line to `**Requires:** none.`. This keeps `Requires:` lines as a literal record of what is *currently* blocking and means `/nightshift:ready` never needs to consult the history file.

**Partially-implemented features** have two routes. If the shipped and remaining work is scoped clearly enough to name a named MVP plus named continuations, use the formal `**Slices:**` block described in `## Slicing` below; `/nightshift:ready` then expands per-slice work units and downstream features can reference specific slices via the `[Feature: slice-name]` link suffix. If the shipped work is real but not yet sliceable (e.g., one layer landed, remaining layers are a wishlist not a planned breakdown), describe the partial progress in the entry's own prose without any special markers. `/nightshift:ready` treats such entries as the `**Requires:**` line dictates; partial progress is editorial context for the reader, not a machine-readable signal.

## Slicing

Features that bundle multiple shippable layers under one design split into a named **MVP** plus one or more **continuations**. The MVP is the smallest surface that unblocks downstream features whose `Requires:` line points at this feature; continuations layer extensions on top.

A sliced feature entry carries a `**Slices:**` block listing each slice (MVP first, then continuations) with one or two sentences on what each delivers. The entry's `**Requires:**` line reflects the *next-to-ship* slice (initially MVP).

After MVP ships, the MVP entry moves to [`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); the MVP bullet in the parent's `**Slices:**` block is struck through with a pointer to the history file; the parent entry stays in its themed section; the top-level `**Requires:**` line advances to the next-to-ship slice's gates; and every other `**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced the just-shipped slice (bare-link defaults to MVP) is edited to drop the now-satisfied reference. When later continuations have independent gates (they can ship in any order rather than sequentially), each slice bullet may carry an inline `**Requires:**` annotation for documentation. Example shape post-MVP:

````
**Slices:**

- ~~MVP: floating-reference core.~~ (Shipped; see FEATURES_HISTORY.md.)
- **Re-anchor events.** Manual UI re-anchor + `AnchorEvent` plumbing.
- **Late-join replay.** `GetSessionHistory` pull endpoint.
- **`RepertoireChordSource`.** Drop-in replacement consuming chart repertoire.
  **Requires:** [chart-repertoire](features/chart-repertoire.md).

**Requires:** none.
````

Downstream features that need a specific continuation (not just the MVP) encode the slice name in the link's display text:

```
[feature-title: continuation name](features/slug.md)
```

A link without a `: slice-name` suffix resolves to the MVP, the default unblock point.

As each slice ships, append a line to `FEATURES_HISTORY.md`:

```
- [Feature title: slice name](features/slug.md): brief note.
```

The parent entry stays in its themed section until the **last** slice ships, at which point it graduates with the final history line.

`/nightshift:ready` reads the top-level `**Requires:**` line and any inline `**Requires:**` annotations on slice bullets, then reports each unshipped slice as a separate work unit (`[Feature title: slice name]`). A slice is "unshipped" when its bullet in the `**Slices:**` block is *not* struck through; the strikethrough is the live slice-status indicator that `/nightshift:ready` reads. The **first unshipped slice** (top-most non-struck bullet) uses the top-level line as its gates; other unshipped slices use their inline annotation if present, or have no extra gates if no annotation. All non-MVP slices **implicitly depend on MVP being struck through**, regardless of top-level or inline gates; a continuation is never reported as Ready while MVP is unshipped. A slice may declare an inline `**Requires:**` pointing at another slice of the same feature via the suffixed-link form, useful when one continuation builds directly on another; resolve the reference by checking whether the target slice's bullet is struck through. As each slice ships, append its entry to `FEATURES_HISTORY.md`, strike through its bullet in the parent's `**Slices:**` block, advance the top-level `**Requires:**` to the new next-to-ship slice's gates, and walk every other `**Requires:**` line in `FEATURES.md` / `BUGS.md` to drop now-satisfied references.

## Companion runtime

### [Companion execution runtime](features/companion-execution-runtime.md)

Host the persistent agent session, supervise the existing state core, own the single consuming diff reader and durable state-event handoff, and execute background work configured by domain features. The runtime owns stable play-session identity, interaction IDs, capability-pending and projection-pending recovery, typed adapter handoff ordering, and the resumable adapter-handoff identity and gate. The already-shipped turn-context acquisition bridge (`core/Get-TurnContext.ps1`, state-extraction spec section 7.5) carried live consumption at dark MVP delivery; an explicit real-root handover to the runtime followed on 2026-10-13. An absent consumer-ownership marker (state-extraction spec section 7.6) defaults to the bridge, a valid marker selects exactly one owner, and the bridge remains available for explicit release until the user directs its retirement. The bridge is not part of the slice breakdown below. Declared design seams are settled and specified in the [runtime-work-projection-persistence-boundaries pattern](patterns/runtime-work-projection-persistence-boundaries.md): durable domain outbox and runtime journal ownership, play-session lifecycle, playthrough identity (signed-in Windows principal), process recovery, and the session-host seam.

**Slices:**

- ~~Single-session state coordinator (MVP).~~ (Locally delivered dark; see [FEATURES_HISTORY.md](FEATURES_HISTORY.md).) A user-directed real-root runtime handover and live chat restart smoke test followed on 2026-10-13; the save-change, crash-redelivery and bridge-release live claims in the governing design remain unprobed.
- **Play-session lifecycle.** Watch the adapter's game process, mint one `playSessionId` per sitting, accept the sign-off command, emit durable session-end events bound to a runtime-owned `sessionCloseId`, keep the close tombstone, reconcile process identity at startup, and start a fresh agent session per sitting.
- **Domain command and projection host.** Admit interactions in order, route domain commands, schedule domain deadlines, signal runtime start, drain registered domain outboxes with `outboxSettlement`, keep the session-end reaction ledger, rebind and acquire projections, and run the journal-repair and maintenance handshakes that domain features such as Session focus consume.
  **Requires:** [Companion execution runtime: Play-session lifecycle](features/companion-execution-runtime.md).
- **Background work broker.** Execute domain-supplied work with bounded concurrency, priority, cancellation, retry, offline handling, and coordinated shutdown. The broker knows how to run and persist attempts, never what is useful, player-visible, or spoiler-safe.
- **Adapter catalog and session isolation.** Enumerate installed adapters and isolate agent sessions, state-event journals, domain persistence, and user preferences by (adapter, signed-in principal). A single-adapter runtime can ship before this generalization.
- **Proactive notice delivery.** Deliver domain-produced, spoiler-projected notices between questions; preserve ordering with pending state events and ordinary responses; retain notices until acknowledged by a presentation client.

**Requires:** none.

### [Coordinator startup latency](features/runtime-startup-latency.md)

Reduce `chat` startup latency with a startup-scoped supervised metadata worker for fresh path admission, file hashing and exact read-only `Inventory`/`Marker` observations, plus bounded bootstrap batching. A watcher-enabled no-save private control reached fake-provider binding and verified worker stop in 49.611 seconds after warming versus 65.242 seconds after batching alone in a separate run; missing-save freshness makes this a lower-bound control, not a representative fresh-state start. A disabled-watcher private recovery control reached the same boundary in 114.434 seconds after warming versus 156.601 seconds in a separate earlier run. A private accepted turn, durable acknowledgement and persisted-provider resume passed; that restart took 47.444 seconds from reopening to resume. The user supplied a timestamped live launch at 54.721 seconds to a fresh, ready chat prompt: marker through bootstrap took 19.237 seconds, state acquisition 11.198 seconds and provider start through readiness 7.633 seconds. Private substage traces found no idle marker interval; a current-tree fake-provider trace attributed 4.245 seconds to durable binding and 1.275 seconds to verified worker shutdown, while leaving the real SDK portion unmeasured. Repeatable live timing, a representative private fresh-state start, enabled-watcher restart and recovery comparisons, normal and not-owner entry-point exits, provider-start refusal, real before-reply worker failure and separately timed current-source interaction gate remain open. Progress feedback is active, presentation changes are deferred, and whole-turn latency remains separate.

**Requires:** none.

## Guidance

### [Session focus](features/session-focus.md)

Declare what kind of progress the player wants now through a runtime-scoped focus that starts balanced and honors six adapter-seeded presets. Canonical selection is ID-only after conversational resolution and requires the runtime's current stable play-session identity. Continuations connect the projection to recommendation and enrichment priority without weakening spoiler, evidence, or classification boundaries, add adaptive ad hoc vocabulary, pair the TUI integration contract, and provide deferred Seeded focus management and Promoted focus management continuations. ComparatorV1 and adapter-handoff contracts are inert compatibility groundwork in the MVP; their live adaptive comparison and handoff behavior remains deferred to the named slices.

**Slices:**

- **Preset focus domain (MVP).** Own the durable finite-capacity canonical catalog and finite serialized wire and comparator representations with typed fail-closed overflow outcomes, plus runtime-transient active selection; support balanced and canonical-ID selection through explicit conversation and runtime commands when a current play-session ID is available; apply startup, session-end, and eight-hour inactivity resets; and expose the provider-neutral focus projection, including typed chat keepalive events.

All non-MVP Session focus slices remain deferred while their exploratory upstream contracts are not graduated, including guidance integration, ad hoc activation, semantic comparison, promotion domain, Promotion delivery and restart rebind, TUI integration, Seeded focus management, and Promoted focus management. Their directional designs and dependency order remain in [Session focus](features/session-focus.md); deferred continuations, including management controls, are not parser-visible work units until graduation.

**Requires:** [Companion execution runtime: Domain command and projection host](features/companion-execution-runtime.md).

## Exploring

Pre-dependency-analysis brainstorms live here. An entry is a draft feature whose breakout file carries `status: exploring` in its frontmatter; the design is being firmed up and a `**Requires:**` line isn't expected yet. `/nightshift:ready` lists these drafts titles-only in a clearly-marked not-ready section, never in the readiness set, and `/nightshift:exploring` renders the full draft list. When a draft firms up enough to declare its upstream gates, move it out of `## Exploring` into the appropriate themed `##` section, add the `**Requires:**` line, and drop the `status: exploring` frontmatter on the breakout file.

### [Source-domain change reset policy](features/domain-change-reset-point.md)

Decide whether a save selector or path change should reset runtime history, balancing stale old-domain delivery against lost changes after a harmless respelling.

### [Blocking-limit window policy](features/runtime-blocking-limit-window-policy.md)

Investigate the provider blocking_limit trigger and decide its classification without inferring a size threshold or capping player text.

### [Coordinator retention checkpoints](features/runtime-retention-checkpoint-cadence.md)

Choose a bounded post-transition retention cadence after measuring the cost of immediate cleanup against delayed compaction.

### [Long-lived runtime history](features/runtime-long-lived-history-preservation.md)

Design safe continuation beyond the fixed handoff reserve while preserving compact evidence and recovery authority.

### [Cleanup warning guidance policy](features/runtime-cleanup-warning-guidance-policy.md)

Investigate whether confirmed deletion-only cleanup failures can be distinguished from incomplete checks before changing conservative withholding.

### [Coordinator whole-turn latency](features/runtime-interaction-latency.md)

Measure whole-turn phases separately from the settlement gate and choose a player-facing latency target.

### [TUI companion app](features/tui-companion-app.md)

Wrap the companion runtime in a terminal interface with streaming chat, freshness and error status, native dialogs, a deferred-results inbox, and per-adapter presentation. Candidate slices separate the terminal shell from advanced dialogs, inbox presentation, theming, and model-effort controls.

### [Streaming speech playback](features/streaming-speech-playback.md)

Add optional, low-latency speech playback to the TUI through a configured Speaches service. Single-message and continuous modes share a protected playback queue, streamed responses carry speak-first prose alternatives for visual blocks, and the runtime persists repairs, validates alternatives in the background, and adapts model concurrency to local or cloud providers. The feature remains a draft until the TUI and runtime background-work boundaries graduate.

### [Adaptive guidance knowledge](features/adaptive-guidance-knowledge.md)

Build a game-specific, evidence-backed knowledge graph that silently reconstructs the player's current horizon on first launch, enriches newly discovered tasks in the background, and adapts research priorities to the user's questions. Only explicitly requested deferred work appears in the TUI task inbox; ordinary warm-start and save-triggered research remains hidden. Candidate slices separate the evidence and disclosure core from horizon reconstruction, check loadouts, thought notices, enrichment, deferred research, interest adaptation, and later cross-game generalization.

### [Psychologist persona](features/psychologist-persona.md)

An in-character therapist treating Harry Du Bois as a patient, commenting on changes in his psychological well-being from vitals and morale, thoughts and build, and choice-pattern evidence. Confirmed delivery modes: woven-in observations on significant changes, an end-of-play-session psych report, and an on-demand report command. Candidate seams follow the runtime, TUI, and adaptive-guidance boundaries.

### [Baldur's Gate 3 adapter](features/baldurs-gate-3-adapter.md)

Add BG3 as the second game: a full save-reading adapter over Larian's LSV/LSF save format (LSLib as the likely foundation) plus a new rules-knowledge layer with embeddings of the D&D 5e (2014) ruleset, defaulting to the CC-BY-4.0 SRD 5.1 with an optional strictly-local owned-rulebook overlay. The concrete second-adapter test case for the runtime's adapter-catalog isolation and adaptive guidance's generic research-adapter contract.

### [Death Stranding Director's Cut adapter](features/death-stranding-directors-cut-adapter.md)

Add the PC Director's Cut as a state-aware logistics companion centered on a porter brief: current orders, cargo and equipment, preparation gaps, useful order batching, and recent progress. Product fit is strong, but implementation is gated on a read-only feasibility spike proving that binary `checkpoint.dat` saves expose enough stable semantic state; automatic map routing and live online structure tracking are outside the initial scope.

## (add sections as features emerge)

Nothing captured yet.

## History

Implemented features are archived in [`FEATURES_HISTORY.md`](FEATURES_HISTORY.md), loaded on demand only (not at session start) so the active backlog above stays scannable. When a feature (or slice) ships, append its entry there rather than to this file, AND walk every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it was the only one, set the line to `**Requires:** none.`). The active `Requires:` lines describe what is *currently* blocking, so `/nightshift:ready` never has to consult the history file; the dependency graph settles as features ship.
