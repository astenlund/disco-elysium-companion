# Concurrent scratch cleanup

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

During the coordinator MVP core repair on 2026-10-07, two focused Test-StateEvents.ps1 harnesses were launched concurrently from the same repository. The Consumer run exited 1 after about 1.2 seconds with 'Remove-Item: The system cannot find the file specified'; the parallel Retirement run passed. Rerunning Consumer sequentially through a wrapper that captures exception and ScriptStackTrace passed. The original failure did not carry a stack. Source inspection found the shared TestSupport.psm1 Clear-StaleScratchRoots scan takes a live-PID snapshot and recursively removes eligible roots without cross-process serialization; a cleanup race is a hypothesis, not a proven cause. Existing named check runner executes groups sequentially, so this does not block the authorized delivery.

## Proposed follow-up

Track an investigation of concurrent scratch-root cleanup, preserving path/ownership guards and adding a deciding concurrent fixture before changing the helper. Sequential harness execution is the current workaround.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
