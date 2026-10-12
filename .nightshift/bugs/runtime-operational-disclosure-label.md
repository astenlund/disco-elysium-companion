# Operational disclosure status label

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh Fable spec review6e2c0dbb and skeptic a963ff1b confirm that an operational unknown or reaper-limit warning currently makes the backend withhold state and label freshness journal/settlementPending. The separate operational field still carries the actual condition and refuses state guidance, so the direction is conservative, but the label differs from the governing fresh-digest/operational distinction. Both assessments classify this minor and not required. Evidence: backend/delivery.ts failure/disclosureOnly conditions, operational.ts operationallyCurrent, and design operational/freshness sections.

## Proposed follow-up

Track a focused alignment of the operational block/status contract and a deciding backend warning trace. Preserve conservative guidance refusal and the persistent warning until the chosen contract is implemented.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
