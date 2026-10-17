# Suppressed provider readiness readout

Deferred from the private healthy-startup implementation review on 2026-10-17. The change has not been published.

## Recorded evidence

A bounded fake-provider probe at `.tmp/status-ready-skeptic-7d1c/probe.ts` forced invalidation after provider binding but before `SessionHost.start` finished. `ProviderLifecycle.suppress()` removed provider authority, but its status remained `ready`. The status-only attachment snapshot reported provider ready and safety unavailable; `submitChat` returned `notReady`, so input stayed blocked. The reviewer classified this as minor. Recheck the path against current code before fixing it.

## Follow-up

Make the provider status reflect immediate suppression, including the bind-then-invalidate startup interval, while preserving the existing no-input and later recovery gates. Add a regression for the status-only snapshot and send refusal.

## Status

Deferred under the user's minor-finding instruction. No fix or publication is authorized by this entry.
