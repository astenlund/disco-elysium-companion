# Prepared-context invalidation assertion

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

During the native historical-state retention repair on 2026-10-11, the isolated prepared-context.test.ts case 'retains ownership on unknown termination and distinguishes unreadable postconditions from incomplete cleanup' failed its control.invalidated assertion. It expected only the prepared-context.txt target but observed the fixture root, the target, and the root twice more. The exact isolated case failed both in the working checkout and in a detached private worktree at the committed pre-change local snapshot before autosquash, with the same shape of additional root invalidations. The other five cases in the combined prepared-context test passed in the current checkout. No production defect or cause of the extra invalidations was established. This case is not one of the current 17 named runtime acceptance checks. The bounded TAP evidence is under .tmp/nightshift/prepared-context-failure-reprobe.txt and .tmp/nightshift/prepared-context-head-tap.txt.

## Proposed follow-up

Investigate the fixture's expected invalidation contract against FilePublisher and PathInspector, then correct the assertion or production behavior based on a deciding source trace and regression. Keep the unrelated native historical-state retention repair and named acceptance checks separate.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
