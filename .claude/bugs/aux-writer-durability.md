# Auxiliary writers lack power-loss durability

Found by the final crash review (2026-08-11), claimed PLAUSIBLE.

## Symptom

The main checkpoint writer uses `WriteThrough + Flush(true)`, but the auxiliary writers
(pending handoff, smoke receipt, section-11 evidence, finalizer checkpoint) write
buffered then `Move`. On true power loss (not a process kill), the moved file can hold
partial bytes; later readers reject it as invalid JSON and the flow fails closed,
requiring manual recovery.

Confirmed by code inspection only; not reproduced.

## Fix

Apply the same `WriteThrough + Flush(true)` to the auxiliary writers (or document the
accepted durability boundary). Add a re-read-after-write check where cheap.

## Status

Tracked 2026-08-11 by user disposition (track). Requires: none.