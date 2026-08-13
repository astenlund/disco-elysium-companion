# Turn-context staging diagnostic rejects a `[pscustomobject]` sourceIdentity

Found by the watcher read-only harness agent (2026-08-11).

## Symptom

Staging `core/staging/Get-TurnContext.ps1` cannot reach exit-0 on a successful run:
`Assert-TurnContextAttemptResult` serializes the attempt diagnostic whose
`sourceIdentity` is a `[pscustomobject]`, which `ConvertTo-CompanionJson` rejects
(`Unsupported Companion JSON value`). The turn-context operation itself runs and the
save mirror stays untouched, but the entry cannot produce its documented exit-0
success.

## Fix

Make the diagnostic's `sourceIdentity` a `CompanionJsonValue` (or serialize it through
the companion writer) so the attempt-result serialization succeeds on the normal path.

## Status

Tracked 2026-08-11 by user disposition (track turn-context kind bug). Requires: none.