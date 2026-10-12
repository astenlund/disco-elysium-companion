# Adapter resolution reasons

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Found 2026-10-06 while repairing the coordinator MVP core. State extraction 7.5 says missing, unloadable, stream-writing or wrong-export validator packages fail configuration resolution as config / adapter-release-corrupt and ordinary adapter.json validation as adapter-config-invalid. The slice made Publish-StateEvent.ps1 keep adapter-release-corrupt, but the shipped bridge does not: core/Get-TurnContext.ps1 maps every Get-AdapterConfig failure to adapter-resolution-failed (read), so the AGENTS.md routing for a config adapter-release-corrupt reason cannot fire at resolution (the reason still arises at the dump and digest stages). Reported by the validating skeptic and not re-read by the controller: Update-CompanionState.ps1 collapses resolution failures to adapter-config-invalid; Get-AdapterConfig raises one generic failure for unresolvable and invalid configurations, so adapter-config-invalid and adapter-resolution-failed cannot be told apart; a removed validator module is classified as ordinary configuration (Test-Acquisition.ps1 asserts this) although 7.5 names a missing package corrupt; and adapter-config-confirmation-failed is in the 7.5 registry but no code emits it. Impact: a less specific reason and a missed repair instruction for the user; every path still fails closed.

## Proposed follow-up

Track it as a bug: decide the resolution-reason contract (the spec's split, or the code's collapse with the spec amended), then reuse the publisher's Get-StateEventAdapterResolutionReason mapping (or its successor) in the turn-context wrapper and the one-shot, with tests per reason.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
