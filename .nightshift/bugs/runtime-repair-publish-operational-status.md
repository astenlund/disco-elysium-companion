# Recovery publish observation status

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh integrated Astra code review 7323d711 and fresh skepticism 2ad7cf5e confirmed a minor operational-status gap in its local pre-publication review snapshot. A warning-free acquisition can mark operational status current and plan version-change recovery; if the later recovery-owned resync Publish call fails before a validated receipt because supervision or reply parsing fails, Kernel.publish does not observe a result and RecoveryCoordinator records repair diagnostics without calling operational.unavailable. Status can therefore retain current for the older publication even though the latest publication observation failed. Pending repair and safety gates still withhold provider input, and no unsafe state delivery was established. This is a source-traced reachable path; a bounded execution fixture has not yet been run. The user directed deferring minor-only findings during this run.

## Proposed follow-up

Later, make pre-result failure of a recovery-owned Publish call mark the operational observation unknown while retaining warnings, without treating unrelated post-observation failures as missing observations. Add a focused regression for an earlier current observation followed by supervisor and parse failure, and verify provider withholding remains intact.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
