# Foreign quarantine entry fails maintenance opaquely

Tracked from the closing triage of Nightshift run f424ec69-4a55-4373-86b5-17ada698c9e4, which delivered [Inventory failure categories](runtime-inventory-diagnostic-opacity.md). The evidence below describes the code at that run and must be checked against current files before a fix.

## Recorded evidence

The lead review of that run found, and its skeptic confirmed, that a file in the runtime data's `quarantine` folder whose name is outside the quarantined-file grammar is admitted by the native Inventory scan: `visitEntry` in `runtime/native/helper/internal/inventory/inventory.go` lets every file under `quarantine/` through, and the scan returns nil for it, so only a folder there is reported as `foreignEntryQuarantine`. The maintenance pass's quarantine trim (`TrimQuarantine` in the same file) then refuses such a file with the generic `inventoryUnavailable`, and `trimQuarantine` in `runtime/src/resource-lifecycle/retention.ts` discards the helper code as a control failure. Startup ends with freshness reason `journalUnavailable` and no capacity slot refused, so the operator sees no quarantine label or remedy. The [runtime design](../features/companion-execution-runtime.md) records the limit in its capacity unavailability passage.

## Decision owed

Surfacing it needs either a maintenance-slot `capacityUnavailable` refusal named `foreignEntryQuarantine`, which would newly block turns and so changes admission, or a new non-refusal diagnostic surface. That choice belongs to the user when the entry is picked up; the trim itself can then classify the entry as the Inventory walk does and keep the helper code in `retention.ts`.

## Status

The user chose to track this item on 2026-11-16. No fix was authorized by that choice.
