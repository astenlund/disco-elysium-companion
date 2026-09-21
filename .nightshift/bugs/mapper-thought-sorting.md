# Mapper does not sort thought arrays (claim 12 unobservable)

Found during Section 11 registry wiring (2026-08-11).

## Symptom

`adapters/disco_elysium/Build-Digest.ps1` emits the `cooking`/`fixed`/`forgotten`/`known` thought arrays in source order. Section 11 claim 12 (Thought canonicalization and highlight joins) requires byte-equivalent SORTED thought arrays (two source-order permutations must produce identical output and no diff). A selector asserting the claim would fail against the current mapper; a passing one would be fabricated. The registry row `section11-12` therefore has no genuine selector.

## Fix

Add an ordinal sort of the thought arrays before digest emission, then the existing canonicalization claim becomes observable.

## Status

Tracked 2026-08-11 by user disposition (track as bug). Requires: none.