# Cold inventory of the event ceiling may exceed the runtime budget

Tracked on 2026-11-16, first as a failing timing test, then restated as the runtime risk below after the measurements showed the failure was not a code regression.

## Recorded evidence

On LUMINOS on 2026-11-16, the first native Inventory read of 8,193 newly written compact events at production depth took 38 to 59 seconds (about 4.7 to 7.2 ms per event), over the runtime's 30-second inventory budget, while a repeated read of the same files took 2.2 to 3.2 seconds (about 0.27 to 0.40 ms per event). A CPU profile of the test put 96% of its run in system calls and about 50 of the first read's 54 seconds in the read-access `CreateFileW` of `nativefs.OpenRead`, one per event file, while the attribute-only opens of the same files took under 2 seconds in total.

The [Go native helper MVP report](../runs/reports/2026-10-24-go-native-helper-mvp.md) recorded about 0.13 ms per event, a measurement the user reports came from LUMINOS too. `bc18d83`, the commit that added the timing test named below, measured 59.3 seconds on 2026-11-16 as well, and the Inventory read path has changed since only on error paths, in a once-per-request input check and in comments, so a helper source regression is ruled out. A newer local Go toolchain is not ruled out, since `runtime/native/helper/go.mod` names only `go 1.26` and the October toolchain was not recorded, but the time is spent inside system calls rather than Go code. Windows updates installed on 2026-10-29, 2026-11-11 and 2026-11-12 and Defender's real-time scanning of each first read-access open are the leading hypothesis, unconfirmed.

`TestInventoryOfTheEventCeilingAtProductionDepthFitsTheBudget` in `runtime/native/helper/internal/inventory/timing_test.go` now gates only the repeated read on its 15-second budget and logs the first read's time, so it no longer protects the first-read case.

## Production write shape

Production does not write events the way the test fixture does: on every completed create or rewrite, the codec reads the published event file back before any Inventory reads it, while the fixture writes its files without reading them. A scratch probe on LUMINOS on 2026-11-16 approximated that shape, writing each of the 8,193 events in place and reading it back through `nativefs.ReadBounded` immediately afterwards: the read-backs took 56.3 seconds in total (about 6.9 ms per event), and the two Inventory reads that followed took 2.19 and 2.08 seconds (about 0.27 and 0.25 ms per event). In that probe the first-open cost landed on the read-back, a few milliseconds per event at write time, which suggests that an Inventory in ordinary play reads files the host has already seen.

The probe differs from production in two ways: the codec reads back in Node rather than Go, and the helper publishes each event by writing a temporary sibling and moving or replacing it into place (`nativefs.PublishValidated`) before the codec reads the final path back, not by writing the final path.

## Open questions

- Whether a file published by that move or replace and then read back is as warm for the next Inventory as the probe's in-place files were, which the probe could not show.
- Whether a reboot or a scanner update makes the host forget what it has scanned, so that the first Inventory afterwards reads a ceiling-sized data root cold, after which its files are warm again.
- What a missed budget does to the player's turn. The runtime caps every inspector native request, Inventory included, at 30 seconds or the operation's remaining deadline if that is shorter, and its resource observation turns a failed Inventory into an unavailable capacity refusal.
- Why a warm read is still two to three times slower per event than the MVP report's figure, which the first-open hypothesis does not explain. At the warm rate the ceiling still fits well inside the budget.

Packing settled history into fewer files, recorded as a candidate in [Long-lived runtime history](../features/runtime-long-lived-history-preservation.md), would also shrink a cold read.

## Status

Open. No fix is designed or authorized by this record.
