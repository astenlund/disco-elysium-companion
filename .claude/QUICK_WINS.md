# Quick wins

Refactors ready to land when time allows; not blocking any feature, but
would improve the codebase meaningfully.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `FEATURES.md`, `BUGS.md`, `PATTERNS.md`). Active
entries are kept inline, organized under thematic `##` sections you
invent as work emerges. When a quick win lands, append a shipped-note
entry to [`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md); do not move
it within this file. Negative-knowledge findings (approaches attempted
and reverted) are first-class promotion candidates from the history
into the relevant `.claude/patterns/<slug>.md` Cautionary tales sections.

Capture shorthand: name the refactor, describe the current smell in a
sentence or two, sketch the preferred shape. A reader should be able to
start work from the entry alone. Anchor entries on identifiers that
survive refactors -- symbol names, entry titles, commit hashes, config
keys -- never on line numbers, plan-phase ordinals, bullet positions,
or temporal qualifiers ("new", "recent"): a precise locator that rots
misleads harder than a coarse one that holds.

**After adding a new entry, run `/nightshift:ready`** from the repo root
to confirm it parses as a quick-wins work item against the real grammar
in `skills/ready/ready.js`. Quick wins carry no `**Requires:**` line; the
failure mode to catch is an entry that doesn't parse as a `- ` bullet or
`###` heading (ready reports it as a prose-only-section notice) while you
can still fix it in the same session.

## Turn-context internals

- **Decompose Invoke-TurnContextAttempt.** One body of roughly 120 lines
  (`core/private/TurnContext.ps1`) mixes init/reaper, the refresh retry loop,
  lock/config/cycle handling, consumption/envelope emission, and terminal-result
  construction (revise-code confirmed finding, 2026-08-13). The reason-taxonomy
  and stability-gate fixes have landed and grew the body further; the 2026-08-14
  revise-code pass added a second confirmed input: the pre-lock and post-lock
  save-candidate enumeration/selection/floor-raise blocks are near-duplicates
  (differing only in `-SourceIdentity` carriage on the terminal returns and the
  floor-null guard) and should collapse into one shared helper as part of this
  decomposition, not as a standalone extraction. Decide during the work whether
  `New-TurnContextTerminalResult` hoists to file scope as well.
  Requires: none.

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
