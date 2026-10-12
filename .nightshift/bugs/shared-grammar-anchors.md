# Exact shared document grammars

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Found 2026-10-06 while repairing the coordinator MVP core; the same defect class as the slice's incarnation-grammar finding. The shared document validators accept values outside their documented grammars. Test-Sha256Hex (core/private/DocumentValidation.ps1) uses the case-insensitive -notmatch with a '$' end anchor, so it accepts uppercase hex and a trailing line feed (probed on this machine: both accepted). Test-Time and Test-Pointer in the same file end in '$' and accept a trailing line feed (source-traced, not executed). adapters/disco_elysium/Build-Digest.ps1 checks its source hashes with the same case-insensitive '$' pattern (line 48 at the time, read). These validators admit digest, diff, baseline, current and nested record documents, so the looseness applies to bridge-mode state as well. The slice's own 7.6 grammars (incarnation, logical outbox identifier, tombstone and settlement hashes) now use exact, case-sensitive checks and no longer depend on Test-Sha256Hex; the shared validators were left unchanged because tightening them changes validation the bridge relies on while state/consumer.json is absent.

## Proposed follow-up

Track it as a bug: make the shared closed-grammar validators exact (case-sensitive -cmatch with '\z', or an ordinal length and character check), sweep the adapters for the same pattern, and add tests that uppercase and trailing-line-feed values are rejected. The core's own hash writers emit lowercase hex (ToLowerInvariant), so tightening should not reject state the core wrote; whether every adapter writer does the same was not checked.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
