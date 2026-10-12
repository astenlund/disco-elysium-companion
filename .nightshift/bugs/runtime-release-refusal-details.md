# Release refusal details

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh cross-cutting Astra review d2e32cbc and independent skepticism c289eb4a confirmed a Minor operator disclosure gap in its local pre-publication review snapshot. A bridge release without the abandonment flag can collect unacknowledged counts, outbox counts and an unfinished repair identifier, then throw ReleaseRefusedError with those facts in details. The CLI formats only its code and generic message, so the refusing command does not show its known reasons. Separate status exposes some journal and repair information but not the core outbox count. This is a no-flag refusal; it does not perform the consumer switch, and no unsafe state delivery was established. The user directed deferring minor-only review findings during this run.

## Proposed follow-up

Later, render ReleaseRefusedError.details with its stable code and message at the CLI boundary, preserving other error formats. Add an isolated refused-command regression covering an event count, unfinished repair identifier and authority uncertainty, while asserting no new intent or consumer switch.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
