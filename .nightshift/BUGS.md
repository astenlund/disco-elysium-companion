# Bugs

Known bugs awaiting attention. Short entries live here; bugs that need more than a few lines of description graduate to a dedicated file under `.nightshift/bugs/<slug>.md`.

This file is **one of four repo-local indexes** agents consult on demand when relevant (alongside `QUICK_WINS.md`, `FEATURES.md`, `PATTERNS.md`). When a bug is fixed, append its entry to [`BUGS_HISTORY.md`](BUGS_HISTORY.md); do not keep a `## Fixed` section inline.

Backlog prose is one paragraph or one bullet per physical line, never hard-wrapped at a column: a search hit then shows the whole entry, the parsers anchor on whole lines, and an edit shows as one changed line instead of a reflowed block. `/nightshift:ready` reports a hard-wrapped file as a notice and `/nightshift:init-backlog` unwraps it.

## Requires lines

**Every open bug entry carries a `**Requires:**` line** declaring what must be in place before the fix can land. Comma-separated on one physical line, same shape as `FEATURES.md` (the parser joins a wrapped line, but the line discipline above forbids wrapping):

- A markdown link to a feature, quick win, or bug. The reference is a current blocker; under the walk-and-remove convention below, a satisfied dependency is edited out of the line at the moment it ships or is fixed.
- The literal word `none.` if the fix is unblocked. An empty label is a structural error; `none.` is the only empty form.

Bare text in `**Requires:**` is a structural error. An external primitive (driver release, vendor support, user decision) goes on a separate, optional `**External:**` line directly below it, same grammar; `none.`, an empty label, or a link in it is a structural error. Every structural error names its remedy.

A missing `Requires:` line is a structural error. `/nightshift:ready` parses these lines. History entries carry neither line.

**After adding a new entry (or a bug breakout file), run `/nightshift:ready`** from the repo root to confirm the new entry parses and its `**Requires:**` line resolves against the real grammar in `skills/ready/ready.js`. A malformed line (wrapped without the parser's join rule, a misplaced `none.`, a broken or ambiguous link target, or a missing line entirely) otherwise sits in the backlog until the next readiness pass surfaces it.

**When a bug is fixed**, move its entry to [`BUGS_HISTORY.md`](BUGS_HISTORY.md) with a brief note on the fix and the commit it landed in; drop its `Requires:` and `External:` lines in the move. If the bug had its own file, keep the file in place as a historical record of the diagnosis.

**Then walk every other `**Requires:**` line in `FEATURES.md` and `BUGS.md`** and remove references to the just-fixed bug: if it was the only item on the line, set the line to `**Requires:** none.`. Mirror of the `FEATURES.md` walk-and-remove convention; `/nightshift:ready` never has to consult `BUGS_HISTORY.md` to resolve dependencies.

## Open

(The reputation-mapping observability entry was resolved 2026-08-12 via the documented option-b narrowing and archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md); its diagnosis file [`bugs/mapper-reputation-observability.md`](bugs/mapper-reputation-observability.md) remains as the historical record. The duplicate-vendor / misspelled-entry / bad-initial-value clauses it names are spec-deferred, not open bugs.)

### Cold inventory of the event ceiling may exceed the runtime budget

On LUMINOS on 2026-11-16, the first native Inventory read of 8,193 newly written compact events at production depth took 38 to 59 seconds (about 4.7 to 7.2 ms per event), over the runtime's 30-second inventory budget, while a repeated read of the same files took 2.2 to 3.2 seconds (about 0.27 to 0.40 ms per event). A CPU profile of the test put 96% of its run in system calls and about 50 of the first read's 54 seconds in the read-access `CreateFileW` of `nativefs.OpenRead`, one per event file, while the attribute-only opens of the same files took under 2 seconds in total. The [Go native helper MVP report](runs/reports/2026-10-24-go-native-helper-mvp.md) recorded about 0.13 ms per event on LUMINOS, but `bc18d83`, the commit that added the timing test named below, measured 59.3 seconds on 2026-11-16 too, and the helper source has changed since only on error paths, so a code regression is ruled out; Windows updates installed on 2026-10-29, 2026-11-11 and 2026-11-12 and Defender's real-time scanning of each first read-access open are the leading hypothesis, unconfirmed. `TestInventoryOfTheEventCeilingAtProductionDepthFitsTheBudget` in `runtime/native/helper/internal/inventory/timing_test.go` now gates only the repeated read on its 15-second budget and logs the first read's time, so it no longer protects the first-read case. Unconfirmed: whether a real data root at the ceiling is ever read cold (events are written one per turn and inventoried soon after, but a reboot or a scanner update may reset what the host has already scanned), and what the runtime then does when the read misses its budget.

**Requires:** none.

## Startup prototype deferred bugs

These findings belong to the private healthy-startup branch. They remain separate from its safety and timing acceptance gates.

### [Suppressed provider readiness readout](bugs/runtime-suppressed-provider-ready.md)

A correction can leave a status-only snapshot labeled provider ready, or after an invalidated initial start indefinitely starting or reconnecting, once input authority has been suppressed; preserve the no-input gate while correcting the readout.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

### [Early input lost during verified attachment](bugs/runtime-async-attach-input-loss.md)

Text entered while the asynchronous attachment proof is pending can be lost before the readline listener is registered.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

## History

Fixed bugs are archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md), loaded on demand only (not at session start) so the active list above stays scannable. When a bug is fixed, append its entry there rather than to this file, AND walk every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it was the only one, set the line to `**Requires:** none.`). The active `Requires:` lines describe what is *currently* blocking, so `/nightshift:ready` never has to consult the history file; the dependency graph settles as bugs are fixed. The bug's breakout record, when present, stays in place and gains a status note saying it was fixed and archived; records archived before 2026-10-24 carry no such note, and for them the history entry is authoritative.
