# Operator commands omit the journal foreign entry remedy

Tracked from the closing triage of Nightshift run f424ec69-4a55-4373-86b5-17ada698c9e4, which delivered [Inventory failure categories](runtime-inventory-diagnostic-opacity.md). The evidence below describes the code at that run and must be checked against current files before a fix.

## Recorded evidence

The final fresh code review of that run found, and its skeptic confirmed, that with a stray file in the runtime data's `journal/events` folder the chat status line shows the move-it-out-by-hand remedy (`formatStatus` in `runtime/src/text-client.ts`), but the operator commands do not. `repair` reads the journal during startup recovery before it reaches the ordinary reservation, so its output carries the freshness reason `journalForeignEntry` only inside the JSON status, and its capacity line reads no current refusal. `consumer bridge` pushes `journalForeignEntry` into its release details, then its `journal/events` listing passes the stray name to `releaseJournalEvidence`, which fails as a control document error, so the operator sees `runtimeUnavailable: Persisted control metadata is invalid.` with no cause or remedy, with or without `--abandon-undelivered`. The same remedy sentence is also written twice in `text-client.ts`, once in the capacity remedy for `foreignEntryJournalEvents` and once in the status line for `journalForeignEntry`, so the two can drift and can appear together on one chat status line.

## Proposed follow-up

Build the `journal/events` remedy from one function in `text-client.ts`, print it in operator-command output when freshness reports `journalForeignEntry`, and have `consumer bridge` refuse with that named reason before its listing, staying a refusal under `--abandon-undelivered`, with CLI tests for repair and consumer bridge over a stray file.

## Status

The user chose to track this item on 2026-11-16. No fix was authorized by that choice. The user selected it for delivery later that day, and it was fixed as direct work after Nightshift could not create a delivery run, as the proposed follow-up describes. The evidence above describes the code before the fix. `text-client.ts` now builds the `journal/events` remedy once; the chat status line carries it without repeating it beside a capacity readout that names it; a `repair` or `consumer` command whose startup returns, or ends in a capacity refusal, prints it with its capacity readout; `consumer bridge` refuses with `journalForeignEntry` and that remedy before its listing, with or without `--abandon-undelivered`; and any other `consumer` failure on such an entry, such as a hand-over from the bridge or a resumed abandon release, prints `journalForeignEntry` with the remedy instead of `runtimeUnavailable`. Fixed and archived in [`BUGS_HISTORY.md`](../BUGS_HISTORY.md) on 2026-11-16.
