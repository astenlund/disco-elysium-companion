# Repair-owned invalid files refused before resume

Deferred from Nightshift run f5a12322-9e2c-4135-911a-a158e27f85e7, whose consumer-transfer fix, commit e96ef93 ("fix(runtime): let unfinished repairs own invalid operations at transfer"), let an unfinished repair own an invalid operation file it lists among its lost operations (exact name and sha256) at consumer transfer. Two other authority checks still refuse any invalid operation file, before such a repair can resume and quarantine it.

## Recorded evidence

- Retention before resume. When the release reservation in `CoordinatorBackend.startup` (`runtime/src/backend/index.ts`) is refused for capacity, the retry runs `retention(false)` before reserving again, and that runs before stream recovery resumes an unfinished repair. Retention maintenance, and the carry and provider authority checks it uses, refuse any invalid operation file, so with a repair-owned invalid predecessor still on disk this restart would refuse before the repair can quarantine it.
- Present carry before resume. `startupOwned` in `runtime/src/backend/recovery.ts` calls `reconcileSafety`, which calls `reconcileCarry` before it resumes the unfinished repair. When the recovery carry file is present, for example after a crash during a gap prerequisite after `preserveRecovery` wrote the carry and before quarantine, `reconcileCarryOwned` throws `SafetyUnavailableError('Present carry has unavailable ownership.')`, because `deferredCarryAuthority` in `runtime/src/backend/provider-authority.ts` returns `unavailable` whenever the inventory holds any invalid file.

Neither path loses or overwrites state, but neither lets the repair finish. On the retention path, backend startup records the failure, marks freshness failed and returns early (`preparationFailed`), skipping consumer reconciliation and stream recovery; on the present-carry path, startup records the recovery failure, marks freshness failed and continues without resuming the repair. A chat start then continues to provider safety and may attach status-only. Since the invalid file stays on disk, a later start meets the same failure while its condition holds. Both were found by reading the code; the crash suites (`consumer-release.test.ts`, `recovery-boundaries.test.ts`) do not reach either path, and no reproduction was run. Both paths predate the run.

## Follow-up

Decide whether these checks should defer to an unfinished repair that owns the invalid files, by the same exact name and sha256 match the consumer transfer uses, without widening provider admission for invalid files no repair owns; then cover each path with a crash-cut or fixture test.

## Status

Tracked at the user's triage on 2026-10-30. No fix or publication is authorized by this entry.
