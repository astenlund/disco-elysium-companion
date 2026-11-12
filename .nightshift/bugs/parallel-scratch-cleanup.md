# Concurrent scratch cleanup

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

During the coordinator MVP core repair on 2026-10-07, two focused Test-StateEvents.ps1 harnesses were launched concurrently from the same repository. The Consumer run exited 1 after about 1.2 seconds with 'Remove-Item: The system cannot find the file specified'; the parallel Retirement run passed. Rerunning Consumer sequentially through a wrapper that captures exception and ScriptStackTrace passed. The original failure did not carry a stack. Source inspection found the shared TestSupport.psm1 Clear-StaleScratchRoots scan takes a live-PID snapshot and recursively removes eligible roots without cross-process serialization; a cleanup race is a hypothesis, not a proven cause. Existing named check runner executes groups sequentially, so this does not block the authorized delivery.

## Proposed follow-up

Track an investigation of concurrent scratch-root cleanup, preserving path/ownership guards and adding a deciding concurrent fixture before changing the helper. Sequential harness execution is the current workaround.

## Resolution

Fixed in Nightshift run 65584d32-c500-4a15-8def-fcabe561940a and archived in [`BUGS_HISTORY.md`](../BUGS_HISTORY.md).

The deciding fixture, the `ConcurrentSweep` group of `core/tests/Test-ScratchCleanup.ps1`, starts six real sweepers together against one large dead-process root. Before any helper change it failed in its first round with the recorded message, `Remove-Item: The system cannot find the file specified.` A diagnostic run captured the cause: a `System.ComponentModel.Win32Exception` thrown from the PowerShell provider's recursive walk (`FileSystemProvider.RemoveDirectoryInfoItem` calling `IsReparsePointLikeSymlink`) when another sweeper had already removed an entry, a terminating error that `-ErrorAction SilentlyContinue` does not suppress. The cleanup-race hypothesis above is therefore confirmed. Exploratory runs before the fix met it on the order of once in several hundred sweeps.

Two further cases came out of review. A sweeper that only tolerated the error could return with part of the tree left while another was still deleting it, and a sweeper started during another's sweep was missing from that sweep's one-time live-process snapshot, so its in-progress work could be reaped; probes showed both failures with staggered starts. The sweep now claims each stale root by an atomic rename to a scratch-shaped name carrying the sweeper's own process id, so exactly one sweeper removes a given tree and the others find it gone and skip it. The claimant removes the tree alone and checks it is gone after every attempt, three at most, and the creator's liveness is decided per entry when the sweep reaches it, counting only a "no such process" lookup as exited. The shape, location and reparse-point guards are unchanged. A dead root that cannot be claimed or removed, for example one an orphaned process still holds open, now fails the sweeping harness instead of being skipped silently.

`core/tests/Test-ScratchCleanup.ps1` runs in the State group of `core/tests/Invoke-StateExtractionTests.ps1`. Its deterministic `Removal` group covers the creator liveness check, a successful claim and removal, a root already gone, a retried partial removal, the attempt bound, a removal failure and a claim replaced by a file; no test refuses the claiming rename itself or provokes the cautious fallbacks for an unreadable process or path. `ConcurrentSweep` starts sweepers together, and `StaggeredSweep` starts a second sweeper while the first is still sweeping; that group failed in round 5 of 15 before liveness was decided per entry and passes after. The stress groups are timing-dependent, so a passing run is evidence rather than proof.

## Status

The user chose to track this item on 2026-10-12. The user selected it for delivery on 2026-11-11, and it was fixed and archived on 2026-11-12.
