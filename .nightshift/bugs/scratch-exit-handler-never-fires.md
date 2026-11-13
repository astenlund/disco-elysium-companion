# Scratch cleanup exit handler never fires

Tracked from Nightshift run a69edaac-e54c-47ec-ba9c-3e2c5bb3418d (2026-11-13), which fixed the runtime fixture host side of the same cause ([Fixture cleanup contract](fixture-cleanup-contract.md)).

## Recorded evidence

`Register-ScratchCleanup` in `core/tests/TestSupport.psm1` registers a `PowerShell.Exiting` engine event to remove every scratch root a harness creates through `New-ScratchCompanionRoot`. A probe in the run registered the same event in a script started as `pwsh -NoProfile -File` on pwsh 7.6.10 and found it never fired: at the end of the script, after an explicit `exit 0`, after reading stdin, and with or without `-SupportEvent` (8 of 8 cases). The core test harnesses all run that way, so their scratch roots stay under `.tmp` until a later harness's `Clear-StaleScratchRoots` sweep reaps them once their creator process has exited. Nothing has been seen to fail because of it; the cost is accumulated scratch and cleanup that only happens as a side effect of later runs.

Two related points from the run's final fixture review belong to the same fix: `runtime/test/fixtures/companion-root.ps1` creates its root and can then fail while staging it (for example when switching the consumer owner fails), and that exit removes nothing; and the header comments of `Clear-StaleScratchRoots` and `Remove-ScratchCompanionRoot` in `TestSupport.psm1` still describe the exit handler as removing roots at an orderly exit.

## Follow-up

Replace the exit-handler cleanup with explicit removal: a helper that removes every scratch root the process registered (built on `Remove-ScratchCompanionRoot`), called from each harness's own `try`/`finally` and from the fixture host's staging failure path, reporting residue rather than hiding it. Keep `Clear-StaleScratchRoots` as the backstop for crash-killed processes, decide whether residue should fail a harness, and correct the two comments.

## Status

The user chose to track this item on 2026-11-13. No fix was authorized by that choice.
