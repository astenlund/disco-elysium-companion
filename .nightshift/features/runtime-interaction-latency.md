---
status: exploring
---

# Coordinator whole-turn latency

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Named private steady-state check runtime-steady-state-timing attempt 5d902b95-9847-4e9c-bb9a-1164a2aa5733 passed on its recorded pre-publication source snapshot with 264 unchanged inputs and a fake provider. Its one-new-record interaction used 456172.949 milliseconds of runtime-owned wall time while the provider callback itself was effectively zero time. The fixed post-publish settlement gate passed separately in 110541.23 milliseconds with 9458.77 milliseconds margin. Preview, preparation, sent mark, send-time copy and acknowledgement all occurred after or outside that gate and contributed to whole-turn delay. The zero-new-record interaction used 340085.99 milliseconds. This is a private Windows fixture with one retained event, not model latency, clean player startup or a live game session; the actual player experience remains unmeasured. The user separately raised the recovery-heavy 27-minute startup as poor UX and favored a follow-up; this item is for whole-turn latency, not that startup path.

## Additional evidence, 2026-10-19

The private selected-image fixture recorded in [selected-image fixture evidence](../reports/runtime-selected-image-fixture-evidence-20261019.md) measured the one acknowledged turn in each of its first seven no-prestart new-save runs, before a later machine slowdown: 122.5, 123.3 and 125.0 seconds on one source commit, the last under kernel tracing, 120.1 and 127.0 seconds on a later commit after review repairs, and 133.8 and 127.3 seconds on a still later commit, each with a synthetic provider whose answer takes effectively no time and with one journal event; four more runs during a later machine slowdown took 135.3 to 142.7 seconds. Durations from 120.1 to 142.7 seconds, none below 120 seconds, fit, but do not yet confirm, the post-acquisition journal drain in `runtime/src/backend/delivery.ts` running until its 120-second settlement budget expires. The cause has not been traced; these are copied-root fixture turns, not live play.

## Direction to investigate

Track a separate whole-turn latency investigation after MVP acceptance. Measure clean and recovery interactions with actual phase boundaries and representative retained history, distinguish mandatory safety work from repeated native helper starts, agree a player-facing latency target, then design and validate a safe reduction without weakening the fixed settlement gate or current ownership and publication checks.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
