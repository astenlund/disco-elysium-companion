# Empty-receipt history walk

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Found out of scope while testing the coordinator MVP core on 2026-10-06. Find-LastEventfulSpan.ps1 exits 1 with 'find-span: [compare]' whenever the walk evaluates no save pair: a lone matching save, an empty save directory, or an immediate age stop. The dry result is built correctly, but New-WalkTraversalEvidence declares -Receipts as a Mandatory [object[]] without [AllowEmptyCollection()], so binding rejects the empty receipt array ('Cannot bind argument to parameter Receipts because it is an empty array') and the walk's catch-all maps it to [compare]. Reproduced on the shipped core (core/DigestDiff.psm1, New-WalkTraversalEvidence) in a stub-adapter scratch root with one save; with two saves the walk returns its dry 'exhausted' result. Section 11 of state extraction says these cases use dry mode with empty receipt evidence. Impact today: a bridge session whose opening diff is uneventful on a fresh or single-save install gets a walk-back failure instead of a dry result; the standing rule already treats walk failure as an enrichment failure and briefs from current state, so nothing is consumed or lost.

## Current validation note

An independent 2026-10-13 check of the current module reproduced separate binding failures for empty Candidates and empty Receipts. The existing-empty-directory route reaches both empty arrays, so allowing only empty Receipts would leave that promised dry-result case broken. This supplements the original lone-save reproduction; the full entry point was source-traced, not run against a real save directory.

## Proposed follow-up

Allow legitimate empty collections for both Candidates and Receipts in New-WalkTraversalEvidence. Add Test-Walk cases for lone-save, empty-directory, and immediate-age traversal that assert their dry results rather than a [compare] failure.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
