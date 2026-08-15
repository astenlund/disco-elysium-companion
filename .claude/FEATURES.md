# Features

Product-level feature ideas captured during brainstorming. Each entry
points at a standalone file under `.claude/features/<slug>.md` with the
full design sketch. Check this index before proposing new feature
directions in the same territory.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `QUICK_WINS.md`, `BUGS.md`, `PATTERNS.md`). Each
entry here is a short paragraph summary plus a `**Requires:**` line, and
optionally a `**Slices:**` block (formal MVP plus continuations; see
`## Slicing` below). For features that are partially done without a
formal slice breakdown, describe the partial progress in the entry's
own prose; there is no separate marker convention for "partially
shipped". The detailed design lives in the linked file. When a feature
(or a slice of a sliced feature) ships, append its entry to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); do not keep an
`## Implemented` section inline.

## Requires lines

**Every feature index entry carries a `**Requires:**` line** declaring
the upstream gates that block the feature. The line is comma-separated;
long lines may wrap across multiple physical lines and `/nightshift:ready` joins
them before parsing. Each item is one of three forms:

- A markdown link to a feature, quick win, or bug entry tracked in one
  of the four indexes. The reference is a current blocker; under the
  walk-and-remove convention below, a satisfied dependency is edited
  out of the line at the moment it ships, so `/nightshift:ready` treats every
  in-backlog reference as actively blocking.
- Bare text. Names an external primitive (SDK feature, infrastructure
  capability, project-level invariant, library, hardware) that the user
  confirms case by case. `/nightshift:ready` flags these as `external`.
- The literal word `none.` if there are no upstream gates.

A missing `Requires:` line is a structural error: every entry must say
something. Silence is not the same as `none.`; it indicates the
dependency review hasn't been done. The `/nightshift:ready` command parses these
lines to compute the unblocked work set.

Downstream relationships (this feature **enables** what) are not
encoded structurally. They can be derived by walking the upstream graph
in reverse, and over-codifying them creates a second source of truth
that drifts. Mention downstream relationships in design prose where
they aid understanding.

**Carve-outs:** sections like `## Working hypotheses`, `## Staging`,
`## Future directions (not yet designed)`, `## Author tooling`, and
`## Exploring` describe pre-feature material (orienting prose,
shipping order, shallow placeholders, workflow notes, exploratory
brainstorms) rather than ready-to-implement entries. Items in those
sections do not carry `Requires:` lines (or, in `## Exploring`'s
case, may carry them as historical artifacts only) and `/nightshift:ready`
ignores them. Working hypotheses / Staging / Future directions
(not yet designed) / Author tooling are bulleted rather than `###`
headings, so the `###`-only candidate filter handles them naturally;
`## Exploring` holds `###` entries but is excluded by name in the
`/nightshift:ready` filter.

Concrete entry shape inside the index. The example mixes a feature
link, a quick-win link, and a bare external primitive to show all
three forms; a real entry only includes whatever it actually depends
on:

```markdown
### [<Feature name>](features/slug.md)

<Short paragraph summary.>

**Requires:** [other-feature](features/other-feature.md), [shared
helper extraction](../QUICK_WINS.md#shared-helper-extraction), some
external primitive.
```

**When a feature is implemented**, move its index entry to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); drop its `Requires:` line
in the move (history entries don't need them). The feature file stays
in place as a historical design record.

**Then walk every other `**Requires:**` line in `FEATURES.md` and
`BUGS.md`** and remove references to the just-shipped feature: if it
was the only item on the line, set the line to `Requires: none.`. This
keeps `Requires:` lines as a literal record of what is *currently*
blocking and means `/nightshift:ready` never needs to consult the history file.

**Partially-implemented features** have two routes. If the shipped
and remaining work is scoped clearly enough to name a named MVP plus
named continuations, use the formal `**Slices:**` block described in
`## Slicing` below; `/nightshift:ready` then expands per-slice work units and
downstream features can reference specific slices via the
`[Feature: slice-name]` link suffix. If the shipped work is real but
not yet sliceable (e.g., one layer landed, remaining layers are a
wishlist not a planned breakdown), describe the partial progress in
the entry's own prose without any special markers. `/nightshift:ready` treats
such entries as the `**Requires:**` line dictates; partial progress
is editorial context for the reader, not a machine-readable signal.

**After adding a new entry (or a feature breakout file), run `/nightshift:ready`**
from the repo root to confirm the new entry parses and its `**Requires:**`
line resolves against the real grammar in `skills/ready/ready.js`. A
malformed line (wrapped without the parser's join rule, a misplaced
`none.`, a broken or ambiguous link target, or a missing line entirely)
otherwise sits in the backlog until the next readiness pass surfaces it.

## Slicing

Features that bundle multiple shippable layers under one design split
into a named **MVP** plus one or more **continuations**. The MVP is
the smallest surface that unblocks downstream features whose
`Requires:` line points at this feature; continuations layer
extensions on top.

A sliced feature entry carries a `**Slices:**` block listing each
slice (MVP first, then continuations) with one or two sentences on
what each delivers. The entry's `**Requires:**` line reflects the
*next-to-ship* slice (initially MVP).

After MVP ships, the MVP entry moves to
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md); the MVP bullet in the
parent's `**Slices:**` block is struck through with a pointer to the
history file; the parent entry stays in its themed section; the
top-level `**Requires:**` line advances to the next-to-ship slice's
gates; and every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`
that referenced the just-shipped slice (bare-link defaults to MVP) is
edited to drop the now-satisfied reference. When later continuations
have independent gates (they can ship in any order rather than
sequentially), each slice bullet may carry an inline `**Requires:**`
annotation for documentation. Example shape post-MVP:

````
**Slices:**

- ~~MVP: floating-reference core.~~ (Shipped; see FEATURES_HISTORY.md.)
- **Re-anchor events.** Manual UI re-anchor + `AnchorEvent` plumbing.
- **Late-join replay.** `GetSessionHistory` pull endpoint.
- **`RepertoireChordSource`.** Drop-in replacement consuming chart repertoire.
  **Requires:** [chart-repertoire](features/chart-repertoire.md).

**Requires:** none.
````

Downstream features that need a specific continuation (not just the
MVP) encode the slice name in the link's display text:

```
[feature-title: continuation name](features/slug.md)
```

A link without a `: slice-name` suffix resolves to the MVP, the
default unblock point.

As each slice ships, append a line to `FEATURES_HISTORY.md`:

```
- [Feature title: slice name](features/slug.md): brief note.
```

The parent entry stays in its themed section until the **last** slice
ships, at which point it graduates with the final history line.

`/nightshift:ready` reads the top-level `**Requires:**` line and any inline
`**Requires:**` annotations on slice bullets, then reports each
unshipped slice as a separate work unit (`[Feature title: slice
name]`). A slice is "unshipped" when its bullet in the `**Slices:**`
block is *not* struck through; the strikethrough is the live
slice-status indicator that `/nightshift:ready` reads. The **first unshipped
slice** (top-most non-struck bullet) uses the top-level line as its
gates; other unshipped slices use their inline annotation if present,
or have no extra gates if no annotation. All non-MVP slices
**implicitly depend on MVP being struck through**, regardless of
top-level or inline gates; a continuation is never reported as Ready
while MVP is unshipped. A slice may declare an inline `**Requires:**`
pointing at another slice of the same feature via the suffixed-link
form, useful when one continuation builds directly on another;
resolve the reference by checking whether the target slice's bullet
is struck through. As each slice ships, append its entry to
`FEATURES_HISTORY.md`, strike through its bullet in the parent's
`**Slices:**` block, advance the top-level `**Requires:**` to the
new next-to-ship slice's gates, and walk every other `**Requires:**`
line in `FEATURES.md` / `BUGS.md` to drop now-satisfied references.

## Exploring

Pre-dependency-analysis brainstorms live here. An entry is a draft
feature whose breakout file carries `status: exploring` in its
frontmatter; the design is being firmed up and a `**Requires:**` line
isn't expected yet. `/nightshift:ready` excludes this section from the readiness
set on purpose. When a draft firms up enough to declare its upstream
gates, move it out of `## Exploring` into the appropriate themed `##`
section, add the `**Requires:**` line, and drop the `status: exploring`
frontmatter on the breakout file.

### [Companion execution runtime](features/companion-execution-runtime.md)

Host the persistent agent session, supervise the existing state core, own the
single consuming diff reader and durable state-event handoff, and execute
background work for domain features. Candidate slices cover the single-session
coordinator, work broker, adapter and playthrough isolation, and proactive
notice delivery.

### [TUI companion app](features/tui-companion-app.md)

Wrap the companion runtime in a terminal interface with streaming chat,
freshness and error status, native dialogs, a deferred-results inbox, and
per-adapter presentation. Candidate slices separate the terminal shell from
advanced dialogs, inbox presentation, theming, and model-effort controls.

### [Adaptive guidance knowledge](features/adaptive-guidance-knowledge.md)

Build a game-specific, evidence-backed knowledge graph that silently reconstructs
the player's current horizon on first launch, enriches newly discovered tasks in
the background, and adapts research priorities to the user's questions. Only
explicitly requested deferred work appears in the TUI task inbox; ordinary
warm-start and save-triggered research remains hidden. Candidate slices separate
the evidence and disclosure core from horizon reconstruction, check loadouts,
thought notices, enrichment, deferred research, interest adaptation, and later
cross-game generalization.

### [Psychologist persona](features/psychologist-persona.md)

An in-character therapist treating Harry Du Bois as a patient, commenting on
changes in his psychological well-being from vitals and morale, thoughts and
build, and choice-pattern evidence. Confirmed delivery modes: woven-in
observations on significant changes, an end-of-play-session psych report, and
an on-demand report command. Candidate seams follow the runtime, TUI, and
adaptive-guidance boundaries.

## (add sections as features emerge)

Nothing captured yet.

## History

Implemented features are archived in
[`FEATURES_HISTORY.md`](FEATURES_HISTORY.md), loaded on demand only
(not at session start) so the active backlog above stays scannable.
When a feature (or slice) ships, append its entry there rather than
to this file, AND walk every other `**Requires:**` line in
`FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it
was the only one, set the line to `Requires: none.`). The active
`Requires:` lines describe what is *currently* blocking, so `/nightshift:ready`
never has to consult the history file; the dependency graph settles
as features ship.
