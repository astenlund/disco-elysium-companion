# Null-detail turn-context warnings cannot round-trip through the envelope

Found by the TurnContext authoring agent (2026-08-11).

## Symptom

`Add-CompanionWarning -Detail $null` stores the empty string, not null. The envelope serializes the warning as `"detail":""`, and `Read-TurnContextEnvelope`'s `Assert-TurnContextWarnings` rejects it (`null -ne $detail` for a `pipeline-current-self-healed` code). The attempt then returns `[protocol]`/`envelope-invalid` instead of emitting the documented "exactly one deduplicated self-healed warning".

## Impact

Section 11 claim 36's self-healed sub-claim cannot round-trip. Any null-detail warning (`pipeline-cleanup-degraded`, and any other warning carrying null detail) cannot pass through a turn-context envelope either.

## Fix

Normalize an empty-string detail back to null in the warning-to-envelope serialization (or store a sentinel that round-trips as null). Add a test proving a null-detail `pipeline-current-self-healed` warning survives a turn-context envelope round-trip exactly once.

## Status

Tracked 2026-08-11 by user disposition (track as bug). Requires: none.