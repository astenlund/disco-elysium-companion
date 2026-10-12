# Quick wins

Refactors ready to land when time allows; not blocking any feature, but would improve the codebase meaningfully.

This file is **one of four repo-local indexes** agents consult on demand when relevant (alongside `FEATURES.md`, `BUGS.md`, `PATTERNS.md`). Active entries are kept inline, organized under thematic `##` sections you invent as work emerges. When a quick win lands, append a shipped-note entry to [`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md); do not move it within this file. Negative-knowledge findings (approaches attempted and reverted) are first-class promotion candidates from the history into the relevant `.nightshift/patterns/<slug>.md` Cautionary tales sections.

Capture shorthand: name the refactor, describe the current smell in a sentence or two, sketch the preferred shape. A reader should be able to start work from the entry alone. Anchor entries on identifiers that survive refactors -- symbol names, entry titles, commit hashes, config keys -- never on line numbers, plan-phase ordinals, bullet positions, or temporal qualifiers ("new", "recent"): a precise locator that rots misleads harder than a coarse one that holds.

**After adding a new entry, run `/nightshift:ready`** from the repo root to confirm it parses as a quick-wins work item against the real grammar in `skills/ready/ready.js`. Quick wins carry no `**Requires:**` line; the failure mode to catch is an entry that doesn't parse as a `- ` bullet or `###` heading (ready reports it as a prose-only-section notice) while you can still fix it in the same session.

Implemented quick wins are archived in [`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when consulted (not at session start) so the active backlog above stays scannable. When a quick win lands, append its entry there rather than to this file.

Backlog prose is one paragraph or one bullet per physical line, never hard-wrapped at a column: a search hit then shows the whole entry, the parsers anchor on whole lines, and an edit shows as one changed line instead of a reflowed block. `/nightshift:ready` reports a hard-wrapped file as a notice and `/nightshift:init-backlog` unwraps it.

## Coordinator MVP follow-ups

These user-tracked cleanups came from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The summaries name deferred work; the run retains the original findings and evidence. None was fixed by this tracking edit.

- **TUI dialog capability wording.** Align the Exploring TUI draft with dialogs:false and plain streaming text without host dialogs.
- **Core tombstone retention summary.** Correct the shared retention summary for protected tombstones and settlement-unknown after evidence pruning.
- **Consolidate runtime repair prose.** State current repair rules directly and reconcile verification placement and consumer lists in the governing design.
- **Opening history disclosure probe.** Probe whether hosted guidance explicitly says earlier save history was not checked on an uneventful opening.
- **Unsent provider refusal reconnect.** Distinguish a beforeSend refusal from subprocess exit and keep the provider alive when safe.
- **Tool-boundary fixture attribution.** Credit direct native admission tests for path containment and keep hook-to-native integration marked unverified.
- **First-install correction disclosure.** Document the first-scope correction and recovering status created by conservative resync, with a focused discharge assertion.
- **Bridge-consumed history notice.** Disclose missing intermediate bridge-consumed history when a provider session resumes at a later runtime snapshot.
- **Core runtime status paragraph.** Remove the stale statement that documentation review and run closing remain due from state-extraction section 7.6.
- **Reconnect summary exceptions.** Qualify the generic reattachment summary when an unresolved pending check forbids provider reconnect.
- **Known-unavailable hosted cache.** Tell hosted guidance when research-cache file tools are refused so it need not attempt known-unavailable access.
- **Startup quiescence code summary.** Document the code-less termination-unverified startup failure and its runtimeUnavailable CLI rendering.
- **Hand-over history recovery row.** Distinguish a persisted validated bridge hand-over result from a crash before result persistence in the recovery table.
- **Unbound recovery matrix preconditions.** Make unbound crash-matrix rows seed a null recovery pointer and assert their preconditions.
- **Coordinator documentation accuracy sweep.** Recheck recorded minor documentation gaps against current code and correct only the claims that remain stale.
- **Private verification provenance.** State attempt selection criteria, cite supporting artifacts, and preserve attempt-specific results before reruns.
- **Generated client fixture evidence.** Modernize or retire the ignored full-session fixture before using it as acceptance evidence.
