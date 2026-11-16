# Foreign quarantine entry fails maintenance opaquely

Tracked from the closing triage of Nightshift run f424ec69-4a55-4373-86b5-17ada698c9e4, which delivered [Inventory failure categories](runtime-inventory-diagnostic-opacity.md). The evidence below describes the code at that run and must be checked against current files before a fix.

## Recorded evidence

The lead review of that run found, and its skeptic confirmed, that a file in the runtime data's `quarantine` folder whose name is outside the quarantined-file grammar is admitted by the native Inventory scan: `visitEntry` in `runtime/native/helper/internal/inventory/inventory.go` lets every file under `quarantine/` through, and the scan returns nil for it, so only a folder there is reported as `foreignEntryQuarantine`. The maintenance pass's quarantine trim (`TrimQuarantine` in the same file) then refuses such a file with the generic `inventoryUnavailable`, and `trimQuarantine` in `runtime/src/resource-lifecycle/retention.ts` discards the helper code as a control failure. Startup ends with freshness reason `journalUnavailable` and no capacity slot refused, so the operator sees no quarantine label or remedy. The [runtime design](../features/companion-execution-runtime.md) records the limit in its capacity unavailability passage.

## Decision

On 2026-11-16 the user chose the named refusal over a non-refusal diagnostic surface and over letting the trim ignore foreign files: a quarantine trim that meets a file outside the quarantined-file grammar refuses the maintenance slot as `capacityUnavailable` with the reason `foreignEntryQuarantine` and its move-it-out-by-hand remedy, so chat turns wait until the file is moved, as for any other unavailable capacity slot. This deliberately changes admission for this case, which the delivering run kept out of scope. The trim classifies the entry as the Inventory walk does, and `retention.ts` keeps the helper code instead of discarding it as a control failure.

## Status

The user chose to track this item on 2026-11-16 and made the decision above the same day. No fix was authorized by those choices. The user selected it for delivery later that day, and it was fixed as direct work after Nightshift could not create a delivery run. The evidence above describes the code before the fix. The quarantine trim now reports a folder or a file outside the quarantined-file name grammar as a foreign quarantine entry when that is the first entry it refuses in its listing, while a publication temporary keeps the generic failure, and the maintenance pass refuses its slot as `capacityUnavailable` with reason `foreignEntryQuarantine` and its remedy, as the [runtime design](../features/companion-execution-runtime.md) states. Fixed and archived in [`BUGS_HISTORY.md`](../BUGS_HISTORY.md) on 2026-11-16.
