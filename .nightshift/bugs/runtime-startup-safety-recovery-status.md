# Startup safety recovery status

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh whole-specae8d56d4 and complete skeptic3ec037f6 confirm minor startup/status documentation debt: unavailable safety can leave chat attached with provider starting and submissions notReady, without a documented recovery action. A failed /new sets failed. Correction to the permanent-latch subclaim: the controller traced and executed real SessionHost/ProviderLifecycle over fake availability, observing start:false, first /new:providerUnavailable, then second /new:started after availability recovered, with one provider start and zero acquisitions. That proves retry admission at the host boundary, not recovery of every real startup fault. Evidence .tmp/nightshift/startup-retry-evidence.json and provider-lifecycle.ts replace(). No loss of state or acknowledgement authority was established.

## Proposed follow-up

Track a precise startup-unavailable status and recovery contract, documenting which faults a repeated /new can recover and which require quit/repair/restart. Preserve the no-provider-input rule and add a deciding real-backend availability fixture for the chosen remedy.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
