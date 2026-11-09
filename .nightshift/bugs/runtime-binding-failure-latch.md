# Latched binding failure leaves the provider open

Deferred from Nightshift run d618cc68-d073-465e-8cf0-949d91fd0c8a on 2026-11-09, where the review of the unsent-refusal change flagged it as outside the agreed scope. The latch predates that change. No real occurrence has been observed.

## Recorded evidence

In `runtime/src/session-host.ts`, the compaction branch of `SessionHost.signal` is the only writer of a failure to `maintenanceFailure`: it records the rejection when the `lifecycle.compacted()` binding publication fails. The `onBound` callback, which `ProviderLifecycle` fires at the end of a successful `establish`, is the only code that clears it, so it lasts until a session is established again or a restart creates a new host. A binding published through `updateBinding`, by a later compaction or a turn acknowledgement, does not clear it.

While it is set, no later turn reaches the provider: once a turn's `backend.acquire` succeeds, `requireMaintenance` throws before `sendTurn`. The latched error then goes through the ordinary failure classification in the `runTurn` catch, usually `providerError`, or `capacityBlocked` for a latched `RuntimeCapacityError`. While capacity is blocked, `submitChat` answers `notReady` and the turn does not run at all. The provider process stays open, so nothing on this path triggers a reconnect. The player can clear the failure with `/new` or a restart, and a state invalidation that replaces the session clears it too. Clearing it does not restore turns while capacity stays blocked, because a session change neither rechecks nor clears a capacity slot, and a binding write that is still refused can leave the provider failed.

The failure itself closes the session in two places, so the reconnect can produce the new binding: a `requireMaintenance` throw from the send gates makes `ClaudeSession.sendTurn` close, and the unsent-refusal change closes a session whose turn came back from `sendTurn` unsent with the failure set. Every other latched failure leaves the process open. Known shapes include:

- A binding failure during a turn that was actually sent, since the close is guarded on `!turn.sent`.
- A compaction during `backend.acquire`, or any other failure latched in a turn that ends before `sendTurn`, which never reaches that close.
- A compaction signal arriving through `passiveSignal` after the turn has settled, or with no turn in flight.

## Follow-up

Decide whether any latched binding failure should end the process so the reconnect produces the binding, rather than waiting for `/new` or a restart. Ending the process during a sent turn or an idle compaction interacts with reconnect and turn recovery, so settle those interactions first. Add a regression for each path the decision covers.

## Status

Tracked by the user's triage decision on 2026-11-09, and fixed later that day: the host now ends the failed session once the failure latches or its active turn has ended, with capacity refusals excluded, as the [runtime design](../features/companion-execution-runtime.md) states. The evidence above describes the code before that fix.
