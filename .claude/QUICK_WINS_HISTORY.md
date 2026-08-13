# Quick wins (history)

Implemented quick wins, archived from `QUICK_WINS.md` so the active
backlog stays scannable. **Archaeological**: loaded on demand, not at
session start. When a quick win lands, append its entry here rather
than to the active file.

Entries appear in the order they shipped. Write each with enough
context to recover the reasoning from the entry alone: investigation
findings, reverted approaches, benchmarks, the commit or scope it
landed in. Negative-knowledge findings (approaches attempted and
reverted, with the reason) are the most valuable content here for
preventing re-attempts; consider promoting those into the relevant
`.claude/patterns/<slug>.md` Cautionary tales section when touching
the pattern doc, leaving a one-line redirect here if cross-referenced.

## Cross-reference resolution

`/nightshift:ready` does **not** scan this file. When a quick win lands, every
other `**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced
it is edited at the same time to drop the now-satisfied reference. The
active `Requires:` lines therefore describe what is *currently*
blocking. This file is purely archaeological — read it when you want
to know what already shipped or to mine negative-knowledge findings,
not to resolve dependencies.

## Entries

- State-extraction-v2 cutover-gated hardening landed 2026-08-12 (scratch-only, no-git; all
  suite-exercised items verified by the full `Test-StateExtractionV2Cutover.ps1` crash matrix,
  which ends `PASS: cutover helper preflight`):
  - Evidence-adoption content binding: `RecordVerificationArtifact` now runs a closed per-name
    validator on every non-envelope evidence artifact (rejecting foreign or malformed bytes), and
    `section-11-results.json` carries producing-input fingerprints (`specSha256`/`coverageSha256`/
    `assertionRegistrySha256`) that re-adoption must match against the current on-disk files. The
    recorded 2026-08-12 fix only covered the `BeginVerification` fresh-root requirement; this closes
    the mid-session stale-adoption path the plan's Task 16 Step 4 contract calls for.
  - Smoke-receipt `.next` sibling adoption: `ExecuteSmoke` now adopts an owned `.state-extraction-v2.next`
    sibling left by a crash between the sibling write and rename (new `smoke-sibling-written` hook +
    `Test-SmokeReceiptSiblingWindowAdoptsOwnedSibling`).
  - Static-hygiene gate: the producer previously failed on a scratch `.tmp` doc's missing newline
    and never failed on live forbidden tokens. It now scans production code only (excludes tests,
    Legacy, docs-dir, and scratch `.tmp`), tightens `schemaVersion.*1` to `schemaVersion\s*[:=]\s*1\b`
    (avoids runtime-prose false positives), and fails on any `removed`-disposition match. Verified
    to flag the live v1 bridge's `LegacyDigestDiff` import pre-cutover (disappears post-cutover).
    Also appended trailing newlines to three migration helpers that lacked them.
  - Retirement legacy-test wiring: `RetireScaffold` now also deletes the three `Test-Legacy*.ps1`
    scripts (which import `LegacyDigestDiff.psm1`) so retirement leaves no dangling imports; the
    retirement manifest and crash-matrix fixture now carry the full seven-target set.
  - Aux-writer durability: four remaining buffered writers (verification evidence, turn capture,
    cleanup checkpoint, rollback finalize marker) switched to `FileStream` `WriteThrough` +
    `Flush(true)` before the atomic replace, matching the section-11 and checkpoint writers.
  - Negative-knowledge note: the four `.claude/bugs/{evidence-adoption,cutover-resume-stalls,
    handoff-next-sibling-window,aux-writer-durability}.md` entries were already fixed and walked to
    `BUGS_HISTORY.md` in the 2026-08-12 revise pass; the files are historical diagnosis records, so
    reopen checks should verify against current code rather than trusting the file's open wording.
