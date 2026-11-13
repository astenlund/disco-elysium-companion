# Fixture cleanup contract

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

The shared companionFixture.close() returned after its helper exited during probe7be03d78, and provider/metadata quiescence plus FileToolAdapter release were verified, but the private .tmp/runtime-fixture-30948-aef76ec3b0eb4691945820c2ff09ff4a directory remained. The original evidence fixtureClosed field means helper closure, not verified physical deletion. The cause of retained files was not established; no manual deletion occurred. This is distinct from the earlier hypothesized parallel scratch-cleanup race.

## Proposed follow-up

Track investigation of the fixture cleanup contract and reporting, keeping host exit, process quiescence and directory removal distinct. Preserve ownership/path guards and obtain deciding failure evidence before changing cleanup.

## Status

The user chose to track this item on 2026-10-12. Fixed on 2026-11-13 in Nightshift run a69edaac-e54c-47ec-ba9c-3e2c5bb3418d and archived in [`BUGS_HISTORY.md`](../BUGS_HISTORY.md); see Resolution.

## Resolution

Cause: the fixture host `runtime/test/fixtures/companion-root.ps1` never removed its root itself. It relied on the `PowerShell.Exiting` handler that `Register-ScratchCleanup` in `core/tests/TestSupport.psm1` registers, and a probe in the fixing run found that this event never fired for scripts run with `pwsh -NoProfile -File` on pwsh 7.6.10 (end of script, explicit `exit 0`, after reading stdin, with and without `-SupportEvent`). Before the fix a plain `close()` with nothing holding the root also left it in place; only a later harness's stale-root sweep reaped such roots.

Fix: after stdin closes, the host removes its root with `Remove-ScratchCompanionRoot` (at most three attempts, under the existing ownership, boundary and reparse guards) and exits 3 with path-free residue on stderr when that bounded removal leaves something at the root path: its kind, an entry count and up to 16 root-relative entries. A guard refusal (a root the host does not own, a reparse point at the root, or an unsafe scratch boundary) instead fails the host without a residue line. `companionFixture().close()` maps that exit to `FixtureResidueError`, whose message carries the sample but no absolute path, and after any other exit checks the root on disk, so a root still standing behind a failed or killed host is also residue, tagged with the host's exit code; the generic host failure remains only when the root is verifiably gone. The live provider and cache-fallback probes record the residue in their observations. Regression coverage is in `runtime/test/companion-fixture.test.ts` (plain close, held handle, non-directory root, failed host, bounded listing) and the Removal section of `core/tests/Test-ScratchCleanup.ps1`.

Verification limits: the stricter `close()` was run against six of the fixture's consumer test files, not the whole runtime suite. Two gaps remain and are tracked in [Scratch cleanup exit handler never fires](scratch-exit-handler-never-fires.md): many core test harnesses still rely on the exit handler for their scratch roots, and the fixture host's own staging-failure exit still removes nothing.
