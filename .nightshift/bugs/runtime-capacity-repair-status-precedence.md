# Capacity fault during active repair

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh Fable spec reviewer 27fb2b00 and independent Astra skeptic eeb8ba3e confirmed a minor status mismatch in the committed coordinator MVP. The governing spec says journal.state is repairing while a repair step executes. A paused in-memory repair with a measured ordinary capacity refusal instead emitted journal.state=fault and fault=runtimeCapacityExceeded because Kernel.emit projects the capacity fault ahead of the requested repairing state. The skeptic reproduced this for a capacity and a gap root, but a resumed root without a current refusal did show repairing. Chat still fails closed; the current CLI prints only after startup and does not expose this in-progress status, so no current CLI recovery failure was established. No code or spec change was made for this finding.

## Proposed follow-up

Triage a narrow backend status-contract cleanup: preserve the executing repair cue while retaining the capacity fault and refused slots, or explicitly settle a different precedence in the governing design. Add paused capacity and noncapacity repair controls for exhaustion, reclassification, completion and failure. Keep existing admission and safety rules unchanged.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
