# Vitals source correction

## Problem

The Disco Elysium adapter currently maps `world.playerCharacter.healingPools.ENDURANCE`
and `.VOLITION` to `character.vitals`. Those fields are consumable healing charges, so
the companion reports the charge counts as Health and Morale.

The live save that exposed the defect contains Health 4/4, Morale 5/5, and two charges
for each pool. Its character sheet records current Endurance `value` 4 and current
Volition `value` 5, while `healingPools` records 2 and 2. Older saves also establish the
same damage relationship. A fresh save taken immediately after one Morale hit records
Volition `value` 4, `maximumValue` 5, and `damageValue` -1 while the Morale charge count
remains 2.

## Design

Keep digest schema version 1 unchanged. Map the existing numeric
`character.vitals[].value` fields as follows:

- Health comes from `world.characterSheet.endurance.value`.
- Morale comes from `world.characterSheet.volition.value`.

The mapper continues to fail closed when either required record or `value` field is
missing. It does not expose `maximumValue`, `damageValue`, or healing-charge inventory.
The existing digest shape and all core consumers therefore remain unchanged.

Reconcile the authoritative `.claude/specs/state-extraction.md`, the extracted
`core/digest-schema.md`, and the Disco Elysium adapter knowledge with this source
correction. Their complete consumer lists stay unchanged. Broaden the documented
`adapterVersion` contract from extra-layout changes alone to any adapter-owned semantic
change that requires existing digests to be rebuilt.

Bump the Disco Elysium `adapterVersion` from 1 to 2 so existing digests with the wrong
semantics are recognized as stale and rebuilt. The next consuming diff is a baseline
reset because the adapter version changed; the companion must disclose that reset under
its standing guidance rules.

## Verification

Add a dedicated adapter-level PowerShell regression test with a complete minimal dump
fixture. At least one vital must use mutually distinct current value, maximum value,
damage value, and charge count. The fresh damaged-Morale shape is the model: `value` 4,
`maximumValue` 5, `damageValue` -1, and charge count 2. The generated digest must report
the current character-sheet values and must not report maximums or charge counts as
vitals.

The adapter suite also covers the fail-closed contract separately for a missing
`endurance` record, a missing `volition` record, a missing `endurance.value`, and a
missing `volition.value`. Each case must exit 1, identify the missing source path on
stderr, and produce no digest.

Verify the rollout in an isolated scratch companion tree. With adapter version 2, a
version 1 current or baseline digest must be classified as stale, reprocessing must
stamp adapter version 2, and the consuming diff must emit `baselineGeneratedAt: null`.
The check must not alter the real project state.

Run the adapter regression test, the core digest/diff suite, the eventful-span suite,
and a fresh live mapper check against a copied save. The live mapper result must report
Health 4, Morale 5, and adapter version 2. All outputs remain under `.tmp`, project state
is unchanged by the live mapper check, and SaveGames remains read-only throughout.
