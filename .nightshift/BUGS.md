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

## Coordinator MVP deferred bugs

These user-tracked findings came from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. Each linked diagnosis preserves its evidence and uncertainty; tracking does not authorize a fix.

### [Concurrent scratch cleanup](bugs/parallel-scratch-cleanup.md)

Reproduce the intermittent concurrent test scratch removal failure before changing shared cleanup logic.

**Requires:** none.

### [Fixture cleanup contract](bugs/fixture-cleanup-contract.md)

Investigate a retained private fixture directory while distinguishing helper exit, process quiescence, and physical removal.

**Requires:** none.

### [Deep helper working directories](bugs/runtime-helper-cwd-length.md)

Investigate measured Windows helper launch failures in deep private working directories without weakening containment or quiescence.

**Requires:** none.

### [Inventory failure categories](bugs/runtime-inventory-diagnostic-opacity.md)

Distinguish residue, unexpected owned entries, and helper transport failures without exposing paths or authorizing deletion.

**Requires:** none.

## Startup prototype deferred bugs

These findings belong to the private healthy-startup branch. They remain separate from its safety and timing acceptance gates.

### [Suppressed provider readiness readout](bugs/runtime-suppressed-provider-ready.md)

A correction can leave a status-only snapshot labeled provider ready, or after an invalidated initial start indefinitely starting or reconnecting, once input authority has been suppressed; preserve the no-input gate while correcting the readout.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

### [Early input lost during verified attachment](bugs/runtime-async-attach-input-loss.md)

Text entered while the asynchronous attachment proof is pending can be lost before the readline listener is registered.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

## Five Ready bugs deferred bugs

These user-tracked findings came from Nightshift run df11cced-f1ff-4618-b967-34f6785c1d5b and were established by reading the code, not by executing the failure. Tracking does not authorize a fix.

### Skipped context shape after an unsent attempt

`WindowRecovery.prepare` writes `nextShape` before an attempt is sent and `cancelBeforeSend` does not restore it, and the retryability inspection in `runtime/src/session-host.ts` prepares and cancels an attempt; after an ordinary failure with the single revalidation spent, a later submission of the same text can skip a shape that has become feasible, and the same inspection marks the episode exhausted when it finds no candidate. The skip rule in `companion-execution-runtime.md` says a skip sends nothing and consumes no failure but not whether it is permanent, so decide that first, then state the rule in the spec or move the write to the actual send.

**Requires:** none.

### Same-record replay checks compare raw identity

`prepareReplayPublication` and the `sourceHandoff` merge in the incompatible-replay branch of `runtime/src/backend/recovery.ts` still use the raw event identity through `handoffFor` where the after-abandon merge sites use `settlementHandoffFor`, so a proven unsettled reappend whose journal or event identity differs from its retained binding is refused rather than merged at either check, whichever repair kind produced the new identity. The refusal fails closed and no fixture yet shows that the sequence occurs. Build a fixture for each check, then decide whether it should accept a proven reappend.

**Requires:** none.

## Three Ready items deferred bugs

These user-tracked findings came from Nightshift run 20cf1b2f-b050-44bd-baec-71479f63b501. Both predate that run and were established by reading the code. Tracking does not authorize a fix.

### Envelope rejection reports unknown consumption

`core/Get-TurnContext.ps1` calls `Read-TurnContextEnvelope` on a structurally valid attempt result with no inner try, so a rejected envelope reaches the outer catch and is reported as `protocol` / `attempt-result-invalid` with unknown consumption, even after the attempt consumed. State-extraction section 7.5 says an envelope validation failure keeps the attempt's consumption state, and its `[protocol]` row and the rationale for `unknown` leave this case out. Decide whether the wrapper keeps the result's state (as `protocol` / `envelope-invalid` with the result's consumption and provenance, with a test) or the spec lists this case as unknown, then fix all three section 7.5 statements together.

**Requires:** none.

### Attempt state setup failure classification

`Invoke-TurnContextAttempt` calls `Initialize-CompanionStateDirectories` with no handler, so a failure there, such as a file squatting where the state directory belongs, ends as `protocol` / `attempt-result-invalid` with unknown consumption, while the section 7.5 `[source]` row and the reason registry promise `source` / `state-setup-failed` for state setup failure. The `UnexpectedFailure` group in `core/tests/Test-TurnContext.ps1` uses this case as its trigger. Either classify the setup failure as `source` / `state-setup-failed` with a test, giving that group a different real trigger, or narrow the `[source]` row in the spec.

**Requires:** none.

## History

Fixed bugs are archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md), loaded on demand only (not at session start) so the active list above stays scannable. When a bug is fixed, append its entry there rather than to this file, AND walk every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it was the only one, set the line to `**Requires:** none.`). The active `Requires:` lines describe what is *currently* blocking, so `/nightshift:ready` never has to consult the history file; the dependency graph settles as bugs are fixed. The bug's breakout record, when present, stays in place and gains a status note saying it was fixed and archived; records archived before 2026-10-24 carry no such note, and for them the history entry is authoritative.
