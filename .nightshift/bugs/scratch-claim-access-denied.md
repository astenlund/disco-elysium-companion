# Scratch claim access denied on fresh trees

Tracked from Nightshift run 5dcd8c2a-3867-414e-ae89-03b3194d7c1a on 2026-11-20, by the user's triage decision.

## Recorded evidence

During the run, the `Removal` group of `core/tests/Test-ScratchCleanup.ps1` began failing intermittently. `[System.IO.Directory]::Move` in `Remove-StaleScratchRoot` (`core/tests/TestSupport.psm1`), claiming a directory tree the group had just built under `.tmp`, failed with "Access to the path ... is denied". When the claim fails that way, the group's stub removal never runs, so other runs failed on a later assertion such as "A tree no attempt removes is attempted exactly three times. Expected '3', actual '0'". Running the group alone failed 1 of 3 times.

The base versions of `TestSupport.psm1` and `Test-ScratchCleanup.ps1` (commit `a19e9ff`), run in a private tree under `.tmp`, failed the same way in 4 of 5 runs. So the run's change did not cause it. Earlier the same day the full harness had passed repeatedly, which points to something in the environment that briefly holds newly created files, for example an antivirus or indexer scan. That holder was not identified. The run's recorded full-harness check passed on a retry.

## Follow-up

First identify the holder, for example with a handle trace while the group runs. Then decide whether directory claims should retry a transient access-denied rename within a short bound, or whether the tests should wait for such scans to settle. A retry must not turn a real refusal into a silent skip: per the stale-sweep rule, an entry that cannot be claimed fails the sweep.

## Status

Open. No fix is authorized by this record.
