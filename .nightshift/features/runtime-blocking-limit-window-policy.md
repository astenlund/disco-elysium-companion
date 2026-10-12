---
status: exploring
---

# Blocking-limit window policy

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Fresh whole-spec Fable reviewer aee5467b and independent Astra skeptic f34d450d confirm a minor, required:false classification/UX limitation. The pinned provider maps prompt_too_long to the bounded contextExhausted 4+1 episode, but blocking_limit without a mapped assistant error to generic providerError with retryable:true. A dated probe separately observed a 12,000,077-byte message return blocking_limit/providerError and a 2,000,093-byte message return prompt_too_long/contextExhausted under different compaction settings. No threshold between them or repeated unchanged retry was measured; the 4,194,304-byte context-block cap excludes player text, which the user chose to keep verbatim and unbounded. The current policy makes no automatic resend and remains fail-closed, but a player-initiated unchanged retry may receive the same generic error without an episode explanation.

## Direction to investigate

Track an explicit classification/UX decision after a bounded source or live trigger probe. If blocking_limit is ever admitted into window recovery, require a correlated capacity cause and retain the existing 4+1 ceiling, verbatim text, player control and safety gates; do not infer a size threshold or add an input cap.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
