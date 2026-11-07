# Installed package keeps loose grammar checks

Tracked after the exact shared document grammars fix in Nightshift run 508c0e0e-906e-49c1-94e1-f0f3e748c98f.

The evidence below was checked on 2026-11-08 against the current checkout and the installed package. Re-check it before a fix, since a later re-stage replaces the package.

## Recorded evidence

The exact shared document grammars fix (commit f2f8355, see [`shared-grammar-anchors.md`](shared-grammar-anchors.md)) made the closed-grammar checks case-sensitive and end-anchored in the tracked sources only. The run deliberately did not rebuild the installed, git-ignored adapter package under `adapters/disco_elysium/releases/2/schema-2`, and that package is what the pipeline runs:

- `adapters/disco_elysium/adapter.json` sets `digestCommand` to `{artifactRoot}/adapters/disco_elysium/Build-Digest.ps1`, so the packaged digest builder runs. It imports the package's own `core/DigestDiff.psm1`, which dot-sources the package's `core/private` copies, `DocumentValidation.ps1` among them.
- The tracked `core/private/AdapterConfig.ps1` loads the digest validator from the package (`$validatorPath` under `$artifactRoot`), so the core imports the packaged `Validate-Digest.psm1`.

The packaged copies still use the earlier forms: `-notmatch` with a `$` anchor for the source hash, dump receipt hash and journal `TASK.` key checks in `Build-Digest.ps1`; the same form for the objective and subobjective `TASK.` checks in `Validate-Digest.psm1`, with a case-insensitive `-replace` for the title prefix; the same form in the packaged `DocumentValidation.ps1` source hash, time and pointer checks (the package predates its `Test-Sha256Hex` helper); and a `$` end anchor in the packaged `EntryFence.psm1` and in the packaged `AdapterConfig.ps1` array-index token check. Until the package is re-staged, those paths accept uppercase hex, lowercase `task.` prefixes and values ending in a line feed. The core's own document checks run from the tracked tree and are already exact.

When the run began, the live `state/` held no uppercase 64-hex value and no string ending in a line feed, so no current document is known to be affected.

## Open questions

Not investigated: whether re-staging the package from the tracked sources changes the Acquisition-config receipt or invalidates the retained baseline, and what cutover or disclosure steps a re-stage then needs.

## Status

The user chose to track this item on 2026-11-08 in that run's follow-up triage. No re-stage was authorized by that choice.
