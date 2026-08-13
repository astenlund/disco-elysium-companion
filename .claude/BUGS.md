# Bugs

Known bugs awaiting attention. Short entries live here; bugs that need
more than a few lines of description graduate to a dedicated file under
`.claude/bugs/<slug>.md`.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `QUICK_WINS.md`, `FEATURES.md`, `PATTERNS.md`).
When a bug is fixed, append its entry to
[`BUGS_HISTORY.md`](BUGS_HISTORY.md); do not keep a `## Fixed` section
inline.

## Requires lines

**Every open bug entry carries a `**Requires:**` line** declaring what
must be in place before the fix can land. Comma-separated, same shape
as `FEATURES.md` (long lines may wrap; `/nightshift:ready` joins them before
parsing):

- A markdown link to a feature, quick win, or bug. The reference is a
  current blocker; under the walk-and-remove convention below, a
  satisfied dependency is edited out of the line at the moment it
  ships or is fixed.
- Bare text. An external primitive (driver release, vendor support,
  user decision) the user confirms case by case.
- The literal word `none.` if the fix is unblocked.

A missing `Requires:` line is a structural error. `/nightshift:ready` parses these
lines. History entries don't carry `Requires:` lines.

**When a bug is fixed**, move its entry to
[`BUGS_HISTORY.md`](BUGS_HISTORY.md) with a brief note on the fix and
the commit it landed in; drop its `Requires:` line in the move. If the
bug had its own file, keep the file in place as a historical record of
the diagnosis.

**Then walk every other `**Requires:**` line in `FEATURES.md` and
`BUGS.md`** and remove references to the just-fixed bug: if it was the
only item on the line, set the line to `**Requires:** none.`. Mirror of the
`FEATURES.md` walk-and-remove convention — `/nightshift:ready` never has to
consult `BUGS_HISTORY.md`.

**After adding a new entry (or a bug breakout file), run `/nightshift:ready`**
from the repo root to confirm the new entry parses and its `**Requires:**`
line resolves against the real grammar in `skills/ready/ready.js`. A
malformed line (wrapped without the parser's join rule, a misplaced
`none.`, a broken or ambiguous link target, or a missing line entirely)
otherwise sits in the backlog until the next readiness pass surfaces it.

## Open

### Reset-write stage reasons collapse to hard-coded details

Spec section 11 ("Turn-context failure injection") distinguishes baseline
serialization, temp-write, and replacement failures, and the five post-baseline
cache stages (fresh validation, comparison, serialization, temp write,
replacement). Production collapses them: `Invoke-CompanionConsumption` wraps each
write in one try with a single detail (`baseline-write-failed`;
`cache-write-failed` beside `cache-target-invalid`), and `Invoke-TurnContextAttempt`
hard-codes the attempt-level reason (`baseline-temp-write-failed` for every
not-consumed reset, `cache-replace-failed` for every consumed one). Registry
constants `baseline-serialize-failed`, `baseline-replace-failed`,
`cache-compare-failed`, `cache-serialize-failed`, and `cache-temp-write-failed`
have no producers. `Write-CompanionBaseline` / `Write-CompanionDiffCache` do not
forward `Write-CompanionStateBytes`'s stage scriptblocks, so no seam reaches the
stages from consumption. The fix threads stage-distinct details through the
consumption results and the attempt layer (extending the `ConsumeResult` detail
registry accordingly) and wires the per-stage fixtures the spec claim names.
Found 2026-08-13 during the claim-41 coverage audit.

**Requires:** none.

### Adapter-validator infrastructure failures escape unclassified

Spec section 11 requires injecting adapter-validator infrastructure failure at
nine boundaries (fresh mapper output, initial target, preflight target,
locked-final target, baseline, pipeline cache, post-baseline fresh cache target,
commit guard, producer envelope) with an exact registry owner and reason each,
using `adapter-validator-infrastructure-failed`. That reason has zero producers:
`Read-CompanionCurrent` catches only `CompanionContentException`, so an
`AdapterConfigurationException` (or the untyped rethrow from
`Assert-AdapterDigestDocument`'s fall-through) escapes as a live exception and
lands in `Invoke-TurnContextAttempt`'s blanket catch as `protocol` /
`envelope-invalid`; the acquisition digest stage collapses non-stage exceptions
to `document-invalid`; the cycle cache emits a fixed reason. The fix classifies
validator infrastructure failures at each boundary per the spec table and wires
the nine-boundary injection fixtures. Found 2026-08-13 during the claim-41
coverage audit.

**Requires:** none.

### Freshness reason vocabulary is collapsed to three ad-hoc details

Spec section 11 requires forcing the shared locked target read to return every
freshness reason with a matching `ConsumeResult` detail. The registry names nine
(`target-missing`, `target-unreadable`, `target-invalid`, `target-schema-stale`,
`target-adapter-stale`, `target-game-mismatch`, `target-domain-mismatch`,
`target-identity-invalid`, `target-below-floor`), but `Read-CompanionCurrent`
exposes a five-value outcome vocabulary that consumption maps to just
`current-stale`, `current-missing-or-invalid`, and `source-floor-not-met`, and
the attempt layer discards even those in favor of a hard-coded
`target-below-floor`. Eight of nine registry reasons have no producers. An
infrastructure failure at the initial target read is also laundered into the
freshness class (unlike the baseline read, which correctly yields `compute`).
The fix widens the locked-read classification to the registry vocabulary,
threads it through consumption and the attempt layer, and wires the
force-every-reason fixture. Found 2026-08-13 during the claim-41 coverage audit.

**Requires:** none.

### Turn-context refresh skips the post-lock re-enumerate and stability gate

Spec section 7.5 step 3 (`.claude/specs/state-extraction.md`, the "refresh acquires
`cycle.lock`, re-enumerates and stability-gates after acquisition" sentence) requires
the turn-context refresh to re-select the save after taking `cycle.lock` and to pass
it through `Test-FileWriteStable`. `Invoke-TurnContextAttempt` instead feeds
`Invoke-CompanionCycle` the save selected before the lock and never calls
`Test-FileWriteStable` (the function is invoked only by the watcher,
`Update-CompanionState.ps1`, and `Find-LastEventfulSpan.ps1`). Consequences: a save
still being written when the cycle starts is processed without the stability gate,
and the section 11 "Acquisition retry taxonomy" claim's typed `stability` /
gate-disappearance retry classes are unreachable through the wrapper, so their
fixture coverage is deferred to this fix. Found 2026-08-13 while authoring the
claim-42 fixtures.

**Requires:** none.

(The reputation-mapping observability entry was resolved 2026-08-12 via the
documented option-b narrowing and archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md); its
diagnosis file [`bugs/mapper-reputation-observability.md`](bugs/mapper-reputation-observability.md)
remains as the historical record. The duplicate-vendor / misspelled-entry / bad-initial-value
clauses it names are spec-deferred, not open bugs.)

## History

Fixed bugs are archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md), loaded
on demand only (not at session start) so the active list above stays
scannable. When a bug is fixed, append its entry there rather than to
this file, AND walk every other `**Requires:**` line in `FEATURES.md`
/ `BUGS.md`: remove the now-satisfied reference (if it was the only
one, set the line to `**Requires:** none.`). The active `Requires:` lines
describe what is *currently* blocking, so `/nightshift:ready` never has to consult
the history file — the dependency graph settles as bugs are fixed.
