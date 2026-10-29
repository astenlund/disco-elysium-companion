# Ungrounded skill-point spending advice

## Recorded observation

During the 2026-10-13 live runtime cutover, the player asked for a brief, spoiler-free summary of the current validated state and said to avoid guessing if state was unavailable. The runtime returned a fresh situation brief that listed three unspent skill points and closed with: "Tell me if you want guidance on what to do next. I'd start with spending those 3 skill points." It gave no allocation, relevant check, build tradeoff, or reason to spend now rather than hold. The response also said the research cache was not consulted. The user judged spending all three points unsound and requested tracking. The transcript establishes advice only, not that any point was spent. The role of cache omission in the advice is unverified.

## Follow-up

Investigate why a summary request produced blanket spending advice and why the cache was not consulted. Keep any skill-point recommendation grounded in current validated choices and the option to hold, disclose uncertainty, and offer an interactive allocation decision under the project guidance rules. Preserve state-event delivery and acknowledgement behavior; this is a response-quality finding.

## Investigation

The hosted session of that brief (the provider's native transcript from 2026-10-13) contains no tool call at all, so the research cache was never attempted: the summary was answered from the turn context alone. Had a read been attempted, the production file-tool adapter would have refused it, as it refuses every research-cache operation in hosted mode (`runtime/README.md`). The closing spending suggestion therefore came from no allocation analysis and no cache facts.

## Fix

Two rules at the end of the Guidance rules section of `AGENTS.md` now apply. A summary or status request gets state, not advice, and any recommendation added to it is a guidance answer bound by every guidance rule, the research-cache read included. Unspent skill points are reported as state; a spending recommendation needs a concrete allocation of skills or a thought slot, a reason to spend now rather than hold, build facts from the digest and check facts from the reconciled research cache, and a thought-slot point is justified under the thought notice rule. Without cache-backed check facts it is build-only, provisional and leans toward holding. Uncertain reasoning is marked as such, spending every point is never recommended as a default, and the interactive allocation decision is offered. `runtime/instructions/runtime-mode.md` needed no change.

Verification used live hosted replays of the original turn context in a private fixture with production file tools refused. On the original summary request, the committed rules urged spending the points in 2 of 3 answers and the new rules in 0 of 3. On a direct question ("How should I spend my 3 unspent skill points?"), all 3 answers under the new rules gave a build-only, provisional allocation that weighed holding, kept at least one point in reserve, disclosed the refused cache read and offered the choice as options (the fixture provides no dialog tool). The sample is small and model output varies, so the evidence shows the rules take effect rather than proving the advice can never recur.

## Status

Tracked at the user request on 2026-10-13. No fix or publication was authorized by that decision. Fixed on 2026-10-25 in Nightshift run f5a12322.
