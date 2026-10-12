# Prototype-named dialog answer

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Astra lead 8833342e and fresh skepticism 4e631458 confirmed a minor verification text-client bug in its local pre-publication review snapshot. Dialogs admits question text __proto__ and requires an own answer property, but text-client.ts builds answers in a plain object, whose inherited setter prevents that property from being created. A composed fake-provider fixture and a direct Dialogs control reproduced invalidAnswer on numbered selection; cancellation still works. No native SDK or real player session was exercised. The user prefers deferring minor review findings; this does not affect the three important safety/contract repairs in the same assessment.

## Proposed follow-up

Later, build question-keyed answers with own properties across initial construction and resets, and add a text-client test for successful __proto__ selection, retry and cancellation. Keep Dialogs' accepted question grammar unchanged.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
