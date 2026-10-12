# State-file overwrite contract

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Found out of scope while designing the coordinator MVP and raised with the user on 2026-10-05 without an answer yet: state extraction section 7.1 says the state writer moves a temp file onto an absent target without overwrite, but core/private/StateFiles.ps1 (line 36 at the time) calls [IO.File]::Move($Temp, $Target, $true), which overwrites. The agreed design does not depend on the existing wording: section 7.6 adds its own create-only commit move for outbox records. The mismatch is pre-existing and affects every other state file the writer commits.

## Proposed follow-up

Track it as a bug: decide whether the spec wording or the code is authoritative (the overwrite is likely intended for in-place replacement of fixed-cardinality files such as current.json, which would make the 7.1 wording the stale side), then reconcile the other side.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
