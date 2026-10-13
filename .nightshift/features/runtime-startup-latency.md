---
status: exploring
---

# Coordinator startup latency

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

In a private runtime-verified-bridge-diagnostic fixture on a local pre-publication source snapshot, the combined release, hand-over, contextUncertain resync recovery and chat startup took roughly 27 minutes before the fake provider host started. The bounded payload-free trace under .tmp/nightshift/verified-bridge-diagnostic records repeated supervised path-admission calls as the dominant measured cost. This is a private, recovery-heavy path, not a measured clean steady-state startup or an actual player session. The user explicitly said that a 27-minute startup is poor UX and should be taken care of, probably as a follow-up. The fixture's final result, gate margin, accepted turn and restart remain separate current MVP obligations.

On 2026-10-13, after the user handed real consumer ownership to the runtime and started `node runtime/src/cli.ts chat`, the CLI showed no progress output while startup ran. At that time the CLI awaited `createChatRuntime` before attaching the text client, which printed its first status and input prompt only after attachment. Silence left the player unable to distinguish slow recovery from a stalled startup. The first live run reached provider session creation roughly 14 minutes after process start. After gracefully quitting, the user restarted chat, reported its prompt in under 11 minutes, and received an answer to a brief current-state question. Those observations do not isolate clean startup from recovery or establish a steady-state latency target.

## Direction to investigate

Track a startup-latency investigation and design after the MVP acceptance work. Measure clean and recovery startup separately, locate mandatory versus duplicate admissions by phase, benchmark any batching or persistent metadata mechanism against path identity, quiescence, failure and deadline safety, then select a UX target and implementation with the user. Preserve the fixed 120-second interaction gate and never treat a faster helper as permission to reuse stale admission.

The startup progress slice is implemented separately from latency optimization. `chat` routes structured phase, UTC timestamp and monotonic elapsed-time events through an injectable callback; the current CLI sink renders them on host stderr and a later sink can write a log. The reported phases are exactly `configuration`, `scopeAdmission`, `instanceGuard`, `runtimeMarker`, `storageRecovery`, `consumerReconciliation`, `streamRecovery`, `outboxDrain`, `startupAcquisition`, `safetyReconciliation`, `retention`, `watcher`, `providerPreparation` and `providerStart`. A 15-second timer reports ongoing work once the current phase has been quiet for at least 15 seconds while the event loop runs; timer alignment can delay the next update. Failed and refused starts have terminal events; success is announced after client attachment, not before. No percentage, save content, credential or path enters the progress event. Focused tests cover formatting, heartbeat and terminal behavior, early failure, and the client attachment boundary. The private cold-recovery integration fixture reached teardown on its first attempt, where its source-integrity guard failed because files had changed during the run; a second unchanged-source attempt was stopped after about 30 minutes without a verdict. Slow-recovery integration remains unverified for this slice. This feedback does not relax any safety gate or reduce startup latency.

Latency optimization remains an exploring design question. This progress slice does not authorize latency optimization, publication, another consumer switch, or changes under SaveGames.
