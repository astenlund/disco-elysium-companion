# Walk result receipts use `[datetime]` savedAt while the span serializes `'o'` strings

Found by the watcher read-only harness agent (2026-08-11).

## Symptom

`Find-LastEventfulSpan`'s closing `Assert-WalkResultSemantics` cross-check fails on any input: receipts carry `SourceIdentity.savedAt` as a `[datetime]`, while traversed candidates and the serialized span use `'o'`-format strings. The traversal and `Read-WalkResultDocument` still run (the walk finds its eventful pair), but the closing semantic re-check is skipped on every input, so a semantic mismatch would go unnoticed.

## Fix

Make the receipt `savedAt` an `'o'`-format string (or parse the serialized span back to `[datetime]` before comparison) so the closing cross-check runs genuinely.

## Status

Tracked 2026-08-11 by user disposition (track walk savedAt bug). Requires: none.