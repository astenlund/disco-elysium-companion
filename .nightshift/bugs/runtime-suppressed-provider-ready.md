# Suppressed provider readiness readout

Deferred from the private healthy-startup implementation review on 2026-10-17. The change has not been published.

## Recorded evidence

A bounded fake-provider probe at `.tmp/status-ready-skeptic-7d1c/probe.ts` forced invalidation after provider binding but before `SessionHost.start` finished. `ProviderLifecycle.suppress()` removed provider authority, but its status remained `ready`. The status-only attachment snapshot reported provider ready and safety unavailable; `submitChat` returned `notReady`, so input stayed blocked. The reviewer classified this as minor. Recheck the path against current code before fixing it.

A related label appeared on 2026-10-19: an invalidation during the initial provider start no longer marks the provider `failed`, so the resulting status-only client shows provider `starting` indefinitely although no start is in progress. A later probe confirmed that label with `submitChat` returning `notReady`. When the provider exited during the initial start before that invalidation, the label stays `reconnecting` instead, again with input refused.

## Follow-up

Make the provider status reflect immediate suppression, including the bind-then-invalidate startup interval and the lasting `starting` or `reconnecting` label after an invalidated initial start, while preserving the existing no-input and later recovery gates. Add a regression for the status-only snapshot and send refusal. [Startup remedy persistence](runtime-startup-remedy-persistence.md) changes the same provider readout after an invalidated initial start, so whichever fix lands first sets a label and refusal-field contract the other must adopt.

## Status

Deferred under the user's minor-finding instruction. No fix or publication is authorized by this entry.

[Startup remedy persistence](runtime-startup-remedy-persistence.md) landed first, on 2026-10-25, so its contract is the one this fix adopts: `provider.safetyRefusal` keeps the remedy of the latest `providerSafetyRefused` notice and clears only when the host itself becomes ready, never because the lifecycle reports a started provider while the host stays unready. A corrected provider label must keep that field independent of `provider.state`, which start and attachment read to decide whether to exit or attach.
