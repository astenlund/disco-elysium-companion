# Per-start helper profiles accumulate

Deferred from the private selected-image fixture work on 2026-10-19 at the user's direction. The change has not been published.

## Recorded evidence

`prepareStartupHelperScratch` creates a new `runtime-startup-*` folder with thirteen profile, temp and toolchain subfolders under the installation's `.tmp` on every selected chat start, and no code removes it. Thirteen such folders from earlier private runs remained in the private worktree on 2026-10-19. In the traced new-save run recorded in [selected-image fixture evidence](../reports/runtime-selected-image-fixture-evidence-20261019.md), the 196 helper `pwsh` processes rewrote PowerShell's `StartupProfileData-NonInteractive` JIT profile in that start's fresh profile about 7.8 million times. Because every start uses a new profile, no start can reuse a warm JIT profile; whether a warm profile would shorten startup is untested.

## Follow-up

Choose between one bounded, admitted helper profile reused per installation and deleting each start's profile after the final verified stop, then measure whether a warm profile shortens new-save startup. Keep every helper profile, temp and compiler destination inside admitted repository-local scratch and keep the .NET first-run opt-outs.

## Status

Tracked at the user's direction pending real-provider timing. No fix or publication is authorized by this entry.
