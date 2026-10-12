---
status: exploring
---

# Cleanup warning guidance policy

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Fresh whole-spec Fable review df6198f2 identified a conditional availability cost: a successful core publish carrying pipeline-cleanup-degraded causes the runtime to withhold state-dependent guidance. A private probe 18a569d4 held one aged reaper candidate, observed a bridge envelope with state and the warning, two successful runtime publish receipts that made delivery disclosure-only, and normal runtime selection after the obstruction cleared. Fresh Astra skepticism 98ee8e60 confirmed this behavior but found it conforms to the accepted conservative operational-status contract. The warning can also mean enumeration failure, and retained reaper-root tokens alone cannot establish a clean check after restart. No loss of core state authority or actual provider answer was demonstrated.

## Direction to investigate

Triage whether to design a more discriminating operational observation for completed deletion-only cleanup failures while preserving incomplete-check uncertainty, warning disclosure, retained roots, acceptance gates and opening/correction duties. Keep the current fail-closed behavior unless a policy change is agreed.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
