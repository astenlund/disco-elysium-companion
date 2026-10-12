# Deep helper working directories

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh Fable review 84cd0e64 and independent Astra skepticism 74df3e0d confirmed a measured private Windows helper launch limitation. A guarded ProcessSupervisor probe completed with working directories of length 240, 247 and 250, and failed with result-invalid transport at 259, 262 and 270 while verifying quiescence. Scoped helper working directories add 147 characters to the companion root in the measured configuration; the canonical project root remained below that bracket, while a standard Nightshift private copy exceeded it. This is not a universal Windows path threshold or proof of a production installation failure. The earlier long-root residue and control probes both failed for this independent reason.

## Proposed follow-up

Track a bounded helper working-directory and launch-diagnostic design. Preserve absolute scope arguments, containment, owned-process quiescence and fail-closed behavior; verify broker and child launch at measured boundary lengths before changing the path policy. Use shallow private fixtures for the current MVP checks.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
