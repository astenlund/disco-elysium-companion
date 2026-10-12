---
status: exploring
---

# Coordinator startup latency

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

In a private runtime-verified-bridge-diagnostic fixture on a local pre-publication source snapshot, the combined release, hand-over, contextUncertain resync recovery and chat startup took roughly 27 minutes before the fake provider host started. The bounded payload-free trace under .tmp/nightshift/verified-bridge-diagnostic records repeated supervised path-admission calls as the dominant measured cost. This is a private, recovery-heavy path, not a measured clean steady-state startup or an actual player session. The user explicitly said that a 27-minute startup is poor UX and should be taken care of, probably as a follow-up. The fixture's final result, gate margin, accepted turn and restart remain separate current MVP obligations.

## Direction to investigate

Track a startup-latency investigation and design after the MVP acceptance work. Measure clean and recovery startup separately, locate mandatory versus duplicate admissions by phase, benchmark any batching or persistent metadata mechanism against path identity, quiescence, failure and deadline safety, then select a UX target and implementation with the user. Preserve the fixed 120-second interaction gate and never treat a faster helper as permission to reuse stale admission.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
