# Disco Elysium: save structure knowledge

Spoiler-safe notes for Companion sessions. Mechanical examples only. Derived during
state-extraction implementation (2026-08-07) from the real Day 4 save and the
disco-elysium-editor repo; authoritative design in .claude/specs/state-extraction.md.

## Save anatomy

A save is `<Name>.ntwtf.zip` in SaveGames\ with five members:

- `*.1st.ntwtf.json`: area id, party state (Kim/Cuno flags), fog-of-war status cache.
- `*.2nd.ntwtf.json`: character sheet, journal, inventory, thoughts, clock, white checks.
- `*.ntwtf.lua`: binary TLV; 5 top-level Lua tables; one is the dialogue variable store
  (~12k variables). Table identities in the known saves, in file order: actor-shaped
  definitions (440), item+thought definitions (259 = 206 + 53), an empty table, the
  variable store (12153), conversation metadata (1501). Only the store is consumed.
- `*.states.lua`: text Lua records; starts with two blank lines. AreaState values come
  in four field shapes (LocationState int, emptied bool, HasEntered bool, disappear
  bool); ShownOrbs values are {OrbSeen=int}.
- `*.FOW.json`: literally {} until populated; ignored.

## TLV format

Type-tagged: S (7-bit length + UTF-8), N (LE float64; integral values are integers),
B (byte), T (int32 arrayCount, elements, int32 hashCount, key-value pairs). The
reference parser in the editor repo treats the first table int32 as padding, flat-merges
top-level tables, and converts mid-file errors into silent partial success; the vendored
copy in dump-tool/parser/ fixes all three (see its header comment). The variable store
is located by content probe (`character.books_read_counter`), exactly one match.
The store contains at least one key pair differing only in letter case (game-data
constant), so PowerShell reads go through core `Read-CompanionJson`, whose materialized
view uses `ConvertFrom-Json -AsHashtable -DateKind String`; the date mode also keeps
ISO-looking game strings from being coerced into `DateTime` values. The helper's
duplicate-aware prepass and owned `RootElement` remain authoritative for exact structure
and numeric semantics.

## Variable namespace

Lowercase location prefixes (e.g. `whirling.`, `plaza.`, `yard.`); uppercase `TASK.`
(1131, matching the editor repo's variables_tasks.json count) and `XP.`; plus `tc`
(thought cabinet), `reputation` (21 axes; the digest exposes 10 via an explicit
digest-key -> store-name map in Build-Digest.ps1), `character`, `stats`, `auto`
(day-cycle flags like `auto.daychange_has_slept`), `inventory`.

## Journal task model

`aquiredJournalTasks.TaskAquisitions` maps TASK.* ids to acquisition timestamps.
`TaskResolutions` has the SAME key set; a resolved task carries a timestamp record, an
unresolved one is JSON null (the editor repo's SCHEMA_REFERENCE.md documents {} instead;
real saves use null; the mapper keys on the absence of dayCounter, covering both).
`SubtaskAquisitions` is sparse (most tasks have no entry = no subobjectives).
`TaskNewStates` is only the journal NEW badge, not a status source. Timestamp records
carry dayCounter/dayMinutes (used) and realDayCounter/seconds (ignored; realDayCounter
diverges from dayCounter on many records). The journal cannot distinguish failed from
done resolutions, and unacquired tasks are never surfaced (spoiler discipline), so the
digest emits only active/done even though the core schema defines failed/locked.

## Catalog-vs-owned traps

`inventoryState.itemListState` is the per-definition state list for ALL 206 items;
`isFresh` is a default-true not-yet-inspected badge. Owned items are
`characterSheet.gainedItems` (equipped is its subset). Similarly
`thoughtCabinetState.thoughtListState` covers all 53 thoughts; the owned arrays are the
characterSheet ones, and the game REMOVES forgotten ids from gainedThoughts. Any
player-facing output must filter through the owned arrays; the catalogs leak unseen
content.

## Titles are humanized ids

The editor repo's variables_tasks.json `description` strings are designer authoring
notes lifted from the dialogue DB (655 of 1131 empty; several state intended outcomes of
in-progress tasks). They are spoiler-unsafe and never displayed. Objective titles are
the humanized id (strip `TASK.`, underscores to spaces); the true journal display text
lives in the conversation layer, which is deliberately unconsumed.

## Mechanical conventions

### Vital pools and healing charges

The Endurance and Volition skill records also carry the effective values shown by the
current Health and Morale bars. The digest maps Health from
`world.characterSheet.endurance.value` and Morale from
`world.characterSheet.volition.value`. A live Morale hit changed Volition from
value/max/damage 5/5/0 to 4/5/-1 while `playerCharacter.healingPools` remained 2/2.
Those healing-pool fields count consumable charges. `maximumValue`, `damageValue`, and
charge counts are not exposed in the current digest schema.

### Other mechanics

Money is integer cents of reAl (`playerCharacter.Money`; digest carries minorUnits for
exact arithmetic). `XpAmount` is progress within the current level and resets on
level-up (negative xpDelta across a level-up is normal forward play). The clock is
`dayCounter` + `dayMinutes` (minutes since 00:00). Save thumbnails (`.jpg`) land within
about a second of their `.ntwtf.zip` on EITHER side (the modal case is a same-second
tie), and steam_autocloud.vdf is rewritten independently by Steam, so "newest file in
SaveGames" is unreliable as a save selector; always filter by `*.ntwtf.zip`.
`auto.daychange_*` variables absent from a save's store default to literal false.

## Digest semantics and admission

The current DE contract is `adapterVersion: 2`. `session.location` is the engine area id
from `header.areaId`. The core schema admits the game-neutral shape, then the immutable
release's `Assert-AdapterDigestSemantics` independently enforces the DE contract before a
digest can become current or baseline state, enter a comparison, suppress a watcher
cycle, authorize a commit-guard discard, or reach guidance. That adapter check includes
the exact 24 skill names and groups, active/done journal limitation, humanized task
titles, health then morale vital order, reAl money constants, and the exact `extra`
shape for party, reputation, thoughts, white-check counts, and day phase.

## Vendored reference DBs (game_data/)

`variables_reputation.json` (21 axes with store names and initial values; validates the
reputation map at digest build) and `skill_key_map.json` (abilities[4] + skills[24];
both hops of the skills name/group join, fail-closed on drift). The skillType
discriminator applies to DIRECT children of characterSheet only; nested modifier records
also carry skillType (including sentinel values) and are not skills.
