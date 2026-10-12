# Pre-repair operation-loss status

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh whole-spec Fable reviewer b6765d56 and independent Astra skeptic de0405c1 confirm a minor, required:false status-label ambiguity. The runtime spec requires status to report an unparseable operation record as a fault before repair starts, yet defines repairFailed as a failed repair step. Current platform/status.ts conservatively reports fault repairFailed for an invalid or unreadable operation even with no repair record. The six-code fault vocabulary and read-only status guard remain enforced; no obligation loss or unsafe provider use was found.

## Proposed follow-up

Track an explicit pre-repair operation-loss status meaning within the existing six-code vocabulary, or a separately reviewed new code if warranted, with a focused no-repair-yet fixture and a truthful clearing rule. Keep status read-only and preserve damaged-operation withholding.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
