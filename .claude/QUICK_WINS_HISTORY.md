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

- Git-ify the companion, shipped 2026-08-13: `git init -b main` in the companion root, in
  place rather than at the entry's suggested `C:\Git\` home; the relocation was split into
  its own quick win because it changes the Claude/Codex project identity (auto-memory and
  hooks are keyed to the AppData path) and needs its own acquisition-path verification.
  `.gitignore` decisions: exclude `state/` (privacy: reputation values and objective state
  are effectively permanent once in pushed history; churn: autosave-driven writes plus the
  live `consume.lock`/`cycle.lock`), `.tmp/` (work copies of real save bytes plus scratch),
  `adapters/disco_elysium/releases/` (binary plus vendored game DBs), `dedump.exe`
  (rebuildable from the versioned `dump-tool` Go source via `build.ps1`), and the
  machine-local overlays `CLAUDE.local.md` and `.claude/settings.local.json`. Root commit
  `ed168d8` (87 files, 22484 insertions). Repo-local `user.email a.stenlund@gmail.com` was
  set because the machine's global git config carries only `user.name`. Pushed to a new
  private GitHub repo `astenlund/disco-elysium-companion`.

- Sweep the pre-migration `.tmp/` debris, shipped 2026-08-13 (208M reclaimed, disk-only;
  `.tmp/` is gitignored). Deleted the enumerated set (revise/build round files and logs,
  the debug scratch directories, the two re-fetchable editor clones after confirming the
  only repo references are attributional provenance notes in `knowledge.md`,
  `state-extraction.md`, and the vendored-from comment in `lua_parser.go`) plus the
  unenumerated migration-era scratch (task3/task10/task15 artifacts, `verify-*` files
  including the `verify-save.zip` save-byte work copy, wiring/parse/probe scripts,
  `go-cache`, `explore`, `sync-gists-skill`) and the 2026-08-13 cutover-morning debug
  leftovers (`tw.bak`, `amb.log`, `walk-validate-live.ps1`, an orphaned `walk-staged-*`
  staging dir; no watcher process was running). Kept `state-extraction-v2-entry-fence.lock`
  (permanent fence) and `nightshift-ambiguity-proposal-2026-08-12.md` (drafted proposal
  belonging to the nightshift repo, flagged to the user rather than deleted). Finding
  during the sweep: the on-disk `revise-state.md` belonged to the converged v2 code loop;
  the Find-LastEventfulSpan plan-revise scratch that
  `memory/projects/find-last-eventful-span-resume.md` lists as read-order items 1-3 was
  already gone before the sweep (overwritten by the later v2 loop), and the referenced
  plan `.claude/plans/2026-08-08-find-last-eventful-span.md` is also absent, so that
  resume path was already broken independently of this cleanup. Resolution (user,
  2026-08-13): the plan-hardening loop is obsolete (`core/Find-LastEventfulSpan.ps1`
  shipped and is live in the guidance rules); the resume memory and its `AGENTS.md`
  pointer were retired, and the stranded nightshift phase-advance wording proposal was
  deleted as not worth pursuing.

- Validator-lease piercing and per-poll re-import, shipped 2026-08-13 (commit `23b0f3c`,
  from the v2 review tech-debt list). `Acquire-AdapterValidatorLease` now returns the
  lease carrying the validated callable (`AdapterValidatorLease.Command`, nulled on
  dispose), so `Get-AdapterConfig` no longer reads `$script:AdapterValidatorCache`
  outside the lock or re-derives the cache key. Import amortization: a new
  `WatcherValidatorWarmHold` on the default `WatcherRuntimeServices` bundle keeps one
  extra lease on the most recently resolved validator path (adopted after each
  successful poll resolve, swapped on release-path change, disposed in
  `Invoke-CompanionWatcher`'s terminal finally), so per-poll snapshot disposal never
  hits refcount zero and one release imports once per watcher run instead of once per
  poll. The spec's at-zero-unload teardown and poison semantics are untouched; the
  warm hold is documented as a lifecycle paragraph in spec section 8 (adoption failure
  never gates a poll, nothing reads callables through the hold). Custom test-built
  service bundles carry no hold and forgo amortization. New `WarmHold` selector in
  `Test-AdapterConfig.ps1` pins hold-resident module retention, reuse without
  re-import, failed-adoption inertness, and unload on hold disposal.

- Walk-policy writer and pointer-tokenizer dedupe, shipped 2026-08-13 (commit `79f93d6`,
  from the v2 review tech-debt list). `Get-AdapterWalkPolicyId` now shares one
  `$writeUInt32BigEndian` scriptblock between the length prefix and the set counts, and
  one `$copySortedOrdinal` scriptblock for the null-tolerant copy-plus-ordinal-sort of
  both policy sets; `Get-AdapterPointerArray` calls `ConvertFrom-DiffPointer` instead of
  hand-rolling the RFC 6901 tokenizer. Byte-layout equivalence of the walkPolicyId hash
  was probe-verified against a verbatim replica of the prior algorithm (populated and
  empty inputs) since the id is persisted and compared by the walk protocol.

- State-file-name and work-lease-grammar single-sourcing, shipped 2026-08-13 (commit
  `3c7dda7`, from the v2 review tech-debt list). `$script:StateFileNames` (ordered map
  Current/Baseline/DiffCache/Bookkeeping) is now the one authority in `StateFiles.ps1`;
  `$script:StateFileTargets` derives from its values and every read/write helper plus
  the watcher's `readBookkeeping` closure (previously a hardcoded
  `state/last-processed.json` join) references the map through
  `Get-CompanionStatePath`. The work-file naming grammar moved beside its writer in
  `Acquisition.ps1` (`$script:WorkNoncePattern`, `$script:WorkWalkIndexPattern`,
  composed `$script:WorkLeaseNamePattern`); the reaper's lease regex and the
  `Invoke-SaveDigest` stem validation both derive from it. The composed lease pattern
  factors the shared nonce suffix out of the old alternation and drops the stem
  check's redundant `{0,9}` digit bound (the following `[int]::TryParse` already
  rejects over-range indexes with the same exception); both rewrites probe-verified
  equivalent against boundary cases.
