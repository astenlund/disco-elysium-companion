# Zero-byte shared state readers

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Found while repairing the coordinator MVP core on 2026-10-06; the same defect class as walk-empty-receipts. A zero-byte file is read completely and then fails to parse, which state extraction defines as content-invalid, but the shared readers reject its empty byte array at parameter binding: probed on this machine, Read-CompanionJson -Path and Read-DigestDocument -Path both throw ParameterBindingValidationException for a zero-byte file, which is not a CompanionContentException, so callers classify it as an infrastructure failure. Source-traced consequences, not executed end to end: a zero-byte last-processed.json makes every watcher poll return bookkeeping-read-failed (core/private/Watcher.ps1, the ReadBookkeeping call) instead of treating the bookkeeping as unreadable and cycling, until a one-shot or turn-context refresh rewrites it; a zero-byte baseline.json or current.json goes through Read-CompanionStateDigest's catch-all (core/private/StateFiles.ps1) as infrastructure-failure, so the bridge reports baseline-read-failed instead of the baseline reset path, and current is not treated as absent and self-healed. The slice fixed only its own 7.6 readers (consumer marker, outbox ledger, outbox records) through a StateEvents-local helper, because changing the shared readers alters shipped bridge and watcher behavior. Only file corruption or external truncation produces a zero-byte state file; the core's writers commit through a flushed temp file and a move.

## Proposed follow-up

Track it as a bug: make the shared byte validator and the digest reader classify a zero-length input as a parse failure (for example [AllowEmptyCollection()] on the byte parameters plus the scanner's own rejection of empty input), then add tests for zero-byte bookkeeping, baseline and current through the watcher, one-shot and turn-context paths. Consider folding walk-empty-receipts into the same sweep for mandatory collection parameters that can legitimately be empty.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
