# Pre-provider interrupt status

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh Fable review6e2c0dbb and skeptic a963ff1b confirm that interrupt during acquisition emits the client terminal immediately while the core acquisition continues and submitChat still returns turnInProgress. The existing session-host test already demonstrates the pending acquisition, but the design and text client do not explain this interval. No extra core command or acknowledgement follows; severity is minor, required:false.

## Proposed follow-up

Track a precise pre-provider interrupt contract and matching client wording or terminal timing, with the existing pending-acquisition test extended to assert the chosen behavior.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
