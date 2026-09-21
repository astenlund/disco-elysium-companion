# Cutover helper cannot resume after two mutation-before-checkpoint crashes

Found by the final crash review (2026-08-11), claimed CONFIRMED.

## Symptom

Two crash windows leave `Invoke-StateExtractionV2Cutover.ps1` un-resumable without manual deletion. Both fail closed (no double-apply), but a controller the operator cannot re-drive defeats the crash-recovery design.

## Windows

1. **Prepare state backup**: a crash (or the injected `state-backed-up` hook) between `Copy-StateBackup` completing and the `state-backed-up` checkpoint write leaves `.tmp/precutover-state-v1.bak` present while the checkpoint still says `prepared`; resume re-enters `Copy-StateBackup` and throws `State backup already exists.`

2. **ExecuteSmoke receipt**: a crash between the smoke receipt publication and the `smoke-passed` checkpoint leaves the receipt present with phase `activated`; resume throws `Smoke receipt already exists.`

The crash matrix does not cover either window (both hooks fire after the full mutation, so the between-mutation-and-checkpoint gap is never exercised).

## Fix

Add resume-adoption: on each phase, if the mutation artifact (backup tree / smoke receipt) is present and valid while the checkpoint has not advanced, adopt it and advance the phase rather than treating it as a re-creation collision. Add crash fixtures terminating between the mutation and the phase checkpoint write.

## Status

Tracked 2026-08-11 by user disposition (track to fix before any future cutover attempt). Requires: none.