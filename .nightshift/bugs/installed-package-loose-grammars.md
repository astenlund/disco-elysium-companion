# Installed package keeps loose grammar checks

Tracked after the exact shared document grammars fix in Nightshift run 508c0e0e-906e-49c1-94e1-f0f3e748c98f.

The evidence below was checked on 2026-11-08 against the current checkout and the installed release `adapters/disco_elysium/releases/2/schema-2`. Re-check it before a fix, since a later release changes what acquisition runs.

## Recorded evidence

The exact shared document grammars fix (commit f2f8355, see [`shared-grammar-anchors.md`](shared-grammar-anchors.md)) made the closed-grammar checks case-sensitive and end-anchored in the tracked sources only. Acquisition executes the packaged copies in the installed, git-ignored release instead, which the run deliberately left unchanged:

- `adapters/disco_elysium/adapter.json` sets `digestCommand` to `{artifactRoot}/adapters/disco_elysium/Build-Digest.ps1`, so the packaged mapper runs. It imports the release's own `core/DigestDiff.psm1`, which dot-sources the release's `core/private` copies.
- The tracked `core/private/AdapterConfig.ps1` imports the digest validator from the same release (`$validatorPath` under `$artifactRoot`), so post-digest validation runs the packaged `Validate-Digest.psm1`.

Packaged checks that still use the earlier case-insensitive or line-feed-tolerant forms, by whether they execute during acquisition:

- Executed by the packaged mapper on dump-tool output: the journal `TASK.` acquisition, resolution and subtask key checks (`-notmatch '^TASK\..+$'`) and the case-insensitive title prefix strip (`-replace '^TASK\.'` in `ConvertTo-Title`) in `Build-Digest.ps1`, and its dump receipt hash check (`-notmatch` with a `$` anchor).
- Executed by the packaged mapper on values the core supplies: the source hash checks at the top of `Build-Digest.ps1`. The core passes its own lowercase hashes there, so the looser form changes no outcome.
- Executed by the packaged mapper on its own output: the source hash and time checks of the packaged `DocumentValidation.ps1`, which its `Read-DigestDocument` reaches. The tracked core checks the same digest again with its exact copies.
- Executed by the packaged validator on every digest: the objective and subobjective `TASK.` id checks in `Validate-Digest.psm1`, with a case-insensitive `-replace` for the title prefix. The tracked core's `Test-Objective` checks ids only as strings, so this is the one place where a `task.` prefix in another case can reach admitted state.

For the `TASK.` checks the difference is case only. The tracked checks (`Test-TaskId` in `Build-Digest.ps1`, `Test-AdapterTaskId` in `Validate-Digest.psm1`) require the ordinal `TASK.` prefix and a non-empty suffix and do not inspect the suffix, so a new release still admits an id ending in a line feed. Line feeds matter only for the hash and time checks.
- Retained but not executed on the acquisition path: the packaged `Test-Pointer` and its `/extra` equality, reached only through `Read-DiffDocument`, which the mapper does not call (it uses the JSON helpers, `Read-DigestDocument` and `Assert-AdapterDigestSemantics`), and the packaged `AdapterConfig.ps1` array-index token check. The packaged `EntryFence.psm1` is imported by nothing; the tracked entry scripts import their own copy.

The core's own post-digest document checks run from the tracked tree and are already exact, so malformed hash and time values the packaged mapper emits are still refused there.

On 2026-11-08 the live `state/current.json` and `state/baseline.json` held no objective or subobjective id outside the uppercase `TASK.` form. At the start of the run the live `state/` held no uppercase 64-hex value and no string ending in a line feed. No current document is known to be affected.

## Proposed follow-up

Ship the fix through a new adapter release, not an in-place change. State extraction section 8 makes installed release directories immutable ("an active release never change in place") and requires a new `adapterVersion` and release for any runnable-artifact change outside a core-schema lockstep upgrade. The new release therefore changes `adapter.json`, and with it the Acquisition-config receipt, which is the SHA-256 of those bytes, and the core then rejects a baseline carrying the old `adapterVersion`, so the cutover costs one deliberate baseline reset. A release built from the current tracked sources also carries tracked changes made after the installed release, not only this fix; for example, the tracked `DocumentValidation.ps1` has the `Test-SourceIdentityGrammar` helper the packaged copy lacks. Consider riding the same version bump as [Source-domain identifier recipe](domain-id-recipe-mismatch.md), whose code alignment also needs one. Still open: the cutover and disclosure steps for the version bump.

## Status

The user chose to track this item on 2026-11-08 in that run's follow-up triage. No new release was authorized by that choice.
