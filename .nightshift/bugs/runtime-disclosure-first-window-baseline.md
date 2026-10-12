# Disclosure-first window baseline

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fable review1eacd4ce and fresh skepticd0860cea confirm that an episode beginning with a failed disclosure leaves failedRelevance and failedBytes null. The first later state-bearing attempt compares its fingerprint to null, spends the revalidation allowance, and on failure still leaves no byte baseline for half-prefix shape2. A concrete trace exhausts after3counted failures plus1revalidation, rather than exceeding the accepted ceiling. No acceptance or acknowledgement authority changes. Both assessments preserve minor, required:false. The null-baseline content/compaction rule is underspecified and tests currently begin disclosure cases after an ordinary failure.

## Proposed follow-up

Track an explicit null-baseline rule for content change and compaction, with disclosure-first success/failure controls that verify allowance consumption and shape progression. Preserve the accepted four-counted-failure plus one-revalidation ceiling and no automatic resend.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
