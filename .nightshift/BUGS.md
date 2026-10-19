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

### [State-file overwrite contract](bugs/statefiles-overwrite-wording.md)

Reconcile the section 7.1 no-overwrite promise with the existing state writer after deciding the intended replacement behavior.

**Requires:** none.

### [Empty-receipt history walk](bugs/walk-empty-receipts.md)

Return the specified dry result when a history walk has no save pair, with lone-save, empty-directory, and age-stop cases.

**Requires:** none.

### [Source-domain identifier recipe](bugs/domain-id-recipe-mismatch.md)

Settle the spec and code hash recipes before changing identifiers, since a code change would reset existing baselines.

**Requires:** none.

### [Zero-byte shared state readers](bugs/zero-byte-shared-readers.md)

Classify empty state and bookkeeping files as invalid content through bridge and watcher recovery paths.

**Requires:** none.

### [Exact shared document grammars](bugs/shared-grammar-anchors.md)

Make shared validator and adapter checks reject uppercase or trailing-line-feed values outside their documented closed grammars.

**Requires:** none.

### [Adapter resolution reasons](bugs/adapter-resolution-reasons.md)

Reconcile adapter package and configuration error reasons across the publisher, bridge, and one-shot commands.

**Requires:** none.

### [Concurrent scratch cleanup](bugs/parallel-scratch-cleanup.md)

Reproduce the intermittent concurrent test scratch removal failure before changing shared cleanup logic.

**Requires:** none.

### [Operational disclosure status label](bugs/runtime-operational-disclosure-label.md)

Align the freshness label with operational warnings that withhold state while preserving conservative guidance refusal.

**Requires:** none.

### [Pre-provider interrupt status](bugs/runtime-preprovider-interrupt-status.md)

Define client terminal timing and turnInProgress behavior while a cancelled turn still has acquisition in flight.

**Requires:** none.

### [Fixture cleanup contract](bugs/fixture-cleanup-contract.md)

Investigate a retained private fixture directory while distinguishing helper exit, process quiescence, and physical removal.

**Requires:** none.

### [Disclosure-first window baseline](bugs/runtime-disclosure-first-window-baseline.md)

Define the missing content baseline after a failed first disclosure while preserving bounded retries and no automatic resend.

**Requires:** none.

### [Startup safety recovery status](bugs/runtime-startup-safety-recovery-status.md)

Distinguish retryable unavailable startup safety from faults requiring repair or restart.

**Requires:** none.

### [Rejected-state repair guidance](bugs/runtime-rejection-repair-restart-guidance.md)

Give restart or repair guidance based on actually unfinished rejection repair authority.

**Requires:** none.

### [Pre-repair operation-loss status](bugs/runtime-operation-loss-status-label.md)

Use a truthful status for an unreadable operation record before any repair step has failed.

**Requires:** none.

### [Sent mark after unsent refusal](bugs/runtime-unsent-window-sent-mark.md)

Assert sent-mark and later redelivery-notice behavior when a window refusal occurs before or after marking.

**Requires:** none.

### [Capacity fault during active repair](bugs/runtime-capacity-repair-status-precedence.md)

Show an executing repair cue alongside capacity refusal rather than silently replacing it with a repair fault.

**Requires:** none.

### [Deep helper working directories](bugs/runtime-helper-cwd-length.md)

Investigate measured Windows helper launch failures in deep private working directories without weakening containment or quiescence.

**Requires:** none.

### [Inventory failure categories](bugs/runtime-inventory-diagnostic-opacity.md)

Distinguish residue, unexpected owned entries, and helper transport failures without exposing paths or authorizing deletion.

**Requires:** none.

### [Invalid runtime marker recovery](bugs/runtime-invalid-marker-recovery-guidance.md)

Define a safe operator procedure for content-invalid runtime metadata without assuming marker deletion is safe.

**Requires:** none.

### [Prototype-named dialog answer](bugs/runtime-prototype-dialog-answer.md)

Create own answer properties for allowed question text such as __proto__ and cover selection, retry, and cancellation.

**Requires:** none.

### [Retained-handoff merge after abandon](bugs/runtime-retained-handoff-merge.md)

Test and correct recovery refusal after unsettled reappend and explicit abandon without weakening original settlement binding.

**Requires:** none.

### [Prepared-context invalidation assertion](bugs/runtime-prepared-context-invalidation-assertion.md)

Investigate extra fixture-root invalidations before changing the assertion or production behavior.

**Requires:** none.

### [Recovery publish observation status](bugs/runtime-repair-publish-operational-status.md)

Mark operational status unknown when recovery publication fails before a validated result while retaining provider withholding.

**Requires:** none.

### [Release refusal details](bugs/runtime-release-refusal-details.md)

Show known refusal facts in the CLI and test that refusal creates no intent or consumer switch.

**Requires:** none.

## Live runtime findings

### [Ungrounded skill-point spending advice](bugs/runtime-ungrounded-skill-point-advice.md)

Investigate why a fresh status brief urged spending all available skill points without an allocation analysis or a player request for a spending decision.

**Requires:** none.

## Startup prototype deferred bugs

These findings belong to the private healthy-startup branch. Unless an entry says otherwise, they remain separate from its safety and timing acceptance gates; the canonical launch spelling entry is a selector acceptance gate.

### [Suppressed provider readiness readout](bugs/runtime-suppressed-provider-ready.md)

A correction can leave a status-only snapshot labeled provider ready after input authority has been suppressed; preserve the no-input gate while correcting the readout.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

### [Early input lost during verified attachment](bugs/runtime-async-attach-input-loss.md)

Text entered while the asynchronous attachment proof is pending can be lost before the readline listener is registered.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

### [Selected path requires canonical launch spelling](bugs/runtime-selected-path-spelling.md)

Launching the direct CLI through a differently cased path would make the selected bootstrap refuse after its transfer mark and exit 1 instead of canonicalizing the roots; latent while the compiled selector is off.

**Requires:** none.

### [Per-start helper profiles accumulate](bugs/runtime-helper-profile-accumulation.md)

Every selected chat start leaves a new `.tmp/runtime-startup-*` helper profile behind, and the fresh profile keeps PowerShell from reusing its startup JIT profile; decide on a reused or cleaned-up admitted profile after real-provider timing.

**Requires:** [Coordinator startup latency](features/runtime-startup-latency.md).

## History

Fixed bugs are archived in [`BUGS_HISTORY.md`](BUGS_HISTORY.md), loaded on demand only (not at session start) so the active list above stays scannable. When a bug is fixed, append its entry there rather than to this file, AND walk every other `**Requires:**` line in `FEATURES.md` / `BUGS.md`: remove the now-satisfied reference (if it was the only one, set the line to `**Requires:** none.`). The active `Requires:` lines describe what is *currently* blocking, so `/nightshift:ready` never has to consult the history file; the dependency graph settles as bugs are fixed.
