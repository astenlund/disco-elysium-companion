# `CompanionJsonValue` has no `Dispose` but `Invoke-CompanionCycle` disposes documents

Found by the watcher read-only harness agent (2026-08-11).

## Symptom

`Invoke-CompanionCycle` disposes `currentDocument`/`baselineDocument`, but the v2
`CompanionJsonValue` has no `Dispose` method, so the cycle only succeeds when current
state is absent. The watcher read-only harness must therefore run the one-shot first on
a fresh acquisition domain and reset companion `state/` before the watcher — exactly the
"absent scratch current and bookkeeping force a trigger" the spec requires, but only
because the disposal call fails on a present document.

## Fix

Either add a no-op `Dispose` to `CompanionJsonValue` (the v1 `JsonDocument`-owned
analogue disposed its document) or guard the cycle's disposal by type so a presented
current document is not disposed through a non-existent member.

## Status

Tracked 2026-08-11 by user disposition (track Dispose gap). Requires: none.