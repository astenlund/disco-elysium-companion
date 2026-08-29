# Handoff atomic writer has an unresumable `.next` sibling crash window

Found by the final crash review (2026-08-11), claimed PLAUSIBLE.

## Symptom

`Write-AtomicUtf8File` (used by `PrepareHandoff` and `RecordHandoff` in `Invoke-StateExtractionV2Cutover.ps1`) writes the `.next` sibling file then renames it. A process kill between the two steps leaves the `.state-extraction-v2.next` sibling on disk; the next invocation throws `An owned handoff artifact already exists.` and needs manual reconcile.

Fail closed (no double-apply, no corruption), but the crash hooks fire only after full publication, so the matrix never exercises the between-write-and-rename window.

## Fix

Extend the crash matrix with a hook that terminates between sibling write and rename, and add adoption logic that reconciles an owned `.next` sibling on resume (verify its bytes against the expected payload, then complete the move).

## Status

Tracked 2026-08-11 by user disposition (track). Requires: none.