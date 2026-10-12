# Fixture cleanup contract

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

The shared companionFixture.close() returned after its helper exited during probe7be03d78, and provider/metadata quiescence plus FileToolAdapter release were verified, but the private .tmp/runtime-fixture-30948-aef76ec3b0eb4691945820c2ff09ff4a directory remained. The original evidence fixtureClosed field means helper closure, not verified physical deletion. The cause of retained files was not established; no manual deletion occurred. This is distinct from the earlier hypothesized parallel scratch-cleanup race.

## Proposed follow-up

Track investigation of the fixture cleanup contract and reporting, keeping host exit, process quiescence and directory removal distinct. Preserve ownership/path guards and obtain deciding failure evidence before changing cleanup.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
