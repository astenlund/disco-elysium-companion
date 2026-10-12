# Retained-handoff merge after abandon

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

The cumulative direct code review carried one previously confirmed Minor case: after an unsettled reappend followed by explicit abandon, merging retained handoffs with different destination event identifiers may refuse recovery. Existing gates fail closed, and the final fresh Astra code assessment found no additional Critical, Important or Minor defect around binding or settlement. This narrow case was deferred under the user's minor-only review preference, not treated as fixed.

## Proposed follow-up

Track a focused recovery fixture and correction for the retained-handoff merge after unsettled reappend and explicit abandon, preserving exact original settlement binding and failure-closed behavior.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
