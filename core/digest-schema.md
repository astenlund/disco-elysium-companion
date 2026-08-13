# Digest and diff schema

Extracted verbatim from .claude/specs/state-extraction.md sections 6.1 and 7.2; the
spec is authoritative on conflict.

### 6.1 Digest schema (documented in core/digest-schema.md, versioned)

```jsonc
{
  "schemaVersion": 2,                            // core schema version
  "adapterVersion": 2,                            // adapter-owned; bumped when adapter semantics require existing digests to be rebuilt
  "game": "disco_elysium",
  "generatedAt": "2026-08-07T10:00:00.0000000Z", // digest generation time, UTC 'o' format like every timestamp in this schema
  "source": {
    "domainId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "saveFile": "AutoSave, ... .ntwtf.zip",     // original file name only, no path
    "savedAt": "2025-08-06T08:28:12.1234567Z",  // original save LastWriteTimeUtc, 'o' format
    "byteLength": 1048576,                       // verified source and work-copy byte count
    "contentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "session": {
    "day": 4,                                    // in-game day (int)
    "time": "08:09",                             // in-game clock HH:mm
    "location": "Martinaise-ext",               // engine area/scene id
    "playtimeNote": null                         // string or null; DE saves carry no playtime
  },
  "character": {
    "level": 25,
    "xp": 53,                                    // progress within the current level (DE: resets on level-up)
    "unspentPoints": 2,
    "money": { "amount": 49.53, "minorUnits": 4953, "minorUnitsPerUnit": 100,
                "currency": "real" },              // minorUnits is the arithmetic source; amount is display
    "vitals": [ { "name": "health", "value": 4 }, { "name": "morale", "value": 5 } ],
    "skills": [ { "name": "Logic", "value": 8, "group": "Intellect" } /* all 24 */ ]
  },
  "objectives": [
    {
      "id": "TASK.example_task",                 // engine id; cited only when precision demands it
      "title": "example task",                   // humanized id; see 6.2 for why not journal text
      "status": "active",                        // active | done | failed | locked
      "acquired": { "day": 1, "time": "08:23" },
      "resolved": null,                          // same shape when resolved
      "subobjectives": [ /* same fields; nested subobjectives is null; see 6.2 */ ]
    }
  ],
  "inventory": {
    "owned": [ "item_id" ],                      // all owned item ids
    "equipped": [ "item_id" ],                   // subset of owned
    "highlights": [ "item_id" ]                  // subset of owned; see 6.2
  },
  "extra": { /* game-specific, see 6.3 */ }
}
```

PowerShell 7.5 or later consumers parse digest and diff documents through
`Read-CompanionJson`. Its `CompanionJsonValue.Materialized` view uses the PowerShell
options in section 2, preserving case-distinct keys and exact timestamp strings, while
its owned `RootElement` preserves exact JSON numbers and arbitrary subtrees for
validation, comparison, and emission.

`Read-DigestDocument` owns the complete core structural validator and always materializes
through `Read-CompanionJson` budget `digest`. Object-key matching
is ordinal and case-sensitive. Objects outside `extra` have exactly the fields shown in
the schema block: missing and unexpected fields both fail validation because an added
field requires a schema-version decision. The required surface is:

| Path | Required type and invariants |
|---|---|
| Root envelope | Object containing integer `schemaVersion`, integer `adapterVersion`, non-empty string `game`, canonical UTC `o` string `generatedAt`, and object/array children `source`, `session`, `character`, `objectives`, `inventory`, and `extra`. |
| `source` | Object containing lowercase 64-hex string `domainId`, non-empty file-name-only string `saveFile`, canonical UTC `o` string `savedAt`, positive integer `byteLength`, and lowercase 64-hex string `contentSha256`. The name contains no directory separator. `domainId` binds the digest to its configured adapter and save selector. The latter two fields are the verified byte receipt and do not participate in save ordering. |
| `session` | Object containing integer `day`, valid zero-padded `HH:mm` string `time`, non-empty string `location`, and string-or-null `playtimeNote`. |
| `character` | Object containing nonnegative integer `level`, `xp`, and `unspentPoints`; `money`; array `vitals`; and array `skills`. |
| `character.money` | Object containing finite decimal `amount`, signed Int64 integer `minorUnits`, positive Int64 integer `minorUnitsPerUnit`, and non-empty string `currency`. `amount` must equal checked Decimal conversion of `minorUnits` divided once by checked Decimal conversion of `minorUnitsPerUnit`; overflow, a non-decimal JSON number, or inequality fails validation. |
| `character.vitals[]` | Objects containing non-empty string `name` and integer `value`; names are unique ordinally. |
| `character.skills[]` | Objects containing non-empty string `name`, integer `value`, and non-empty string `group`; names are unique ordinally. |
| `objectives[]` | Objects containing non-empty string `id`, string `title`, status in `active`, `done`, `failed`, or `locked`, acquired day/time object, resolved null or day/time object, and array `subobjectives`; objective ids are unique ordinally. |
| `objectives[].subobjectives[]` | Objects with the same scalar and timestamp fields as an objective plus `subobjectives: null`; ids are unique within their parent and no deeper nesting is legal. |
| `inventory` | Object containing non-empty-string arrays `owned`, `equipped`, and `highlights`; each array is ordinally unique, and equipped/highlights are subsets of owned. |
| `extra` | Object. Every JSON-compatible value, including null within the digest's maximum depth of 62, is legal beneath it; its game-specific shape is adapter-owned and is not a structural requirement of the game-neutral core validator. |

Every day/time object contains exactly integer `day` plus valid zero-padded `HH:mm`
string `time`. Canonical UTC `o` means RoundtripKind parsing succeeds, the result is UTC,
and formatting it back with `o` reproduces the input ordinally. Outside `extra`, JSON
null is legal only where the table names it. Numeric fields reject strings that
PowerShell could coerce. Every structural type and numeric check uses `RootElement`,
never the PowerShell-materialized value. In this schema, `integer` means a JSON number
whose raw token has integer grammar and for which `JsonElement.TryGetInt64` succeeds;
`decimal` means a JSON number for which `JsonElement.TryGetDecimal` succeeds. A value
accepted only through Double conversion is invalid.
The validator returns the same validated `CompanionJsonValue` on success and throws
`CompanionDocumentValidationException` on failure; it never calls `exit` and never
returns a partial document.

Core structural validity is necessary but not sufficient for an authoritative state.
Every adapter release exports `Assert-AdapterDigestSemantics` from the fixed package path
`{artifactRoot}\adapters\<adapter>\Validate-Digest.psm1`. The function accepts one already
core-valid `CompanionJsonValue`, writes no PowerShell stream, returns no object, and either
returns normally or throws typed `AdapterDigestValidationException` for a semantic
rejection. Import failure, a missing or extra export, stream output, an unexpected return
object, or any other exception is validator infrastructure failure, never evidence that
the digest is merely invalid. The core module owns validator loading through the
process-local lease mechanism in section 8. A completed compatibility configuration owns
one lease and its callable for the snapshot; provisional resolution owns the lease until
it transfers to a completed snapshot or releases on failure. No loaded module instance
is left unowned or reused after failed admission.

`Assert-AdapterDigestDocument -Document <CompanionJsonValue> -AdapterConfig <validated
compatibility object>` is the game-neutral core wrapper. It first requires the running
core version, adapter version, game, and source domain to equal the held configuration,
then invokes that configuration's adapter callable and returns the same document only on
success. `Read-AdapterDigestDocument` composes `Read-DigestDocument` with that assertion
for path or JSON input. Only an adapter-admitted digest may become authoritative current
or baseline state, enter a diff or walk comparison, suppress a watcher cycle, authorize a
commit-guard discard, or appear as turn-context state. Keeping this second validation at
the core trust boundary was chosen over trusting mapper self-validation because a
miswired or regressed mapper can still emit a core-valid, correctly stamped document with
the wrong adapter semantics.

Complete adapter-admission callers are `Invoke-SaveDigest` for pipeline and walk output;
the shared baseline reader; the shared consuming operation's post-baseline fresh
cache-target read; `Get-Diff.ps1` target reads; every initial, preflight, and
locked-final `Get-TurnContext.ps1` target read; the watcher quiescence decision; the
cycle commit-guard discard decision; historical walk comparisons; producer-mode nested
state validation in `Read-TurnContextEnvelope`; and section 10's host-side nested-state
gate. A narrow identity prefilter is not another admission caller. No other path may use
a digest as adapter-valid.

Complete consumer list for the schema: `DigestDiff.psm1`'s differ and shared consuming
operation; `Invoke-SaveDigest` through post-digest admission for both pipeline cycles and
walk candidates; `Find-LastEventfulSpan.ps1` through comparisons of admitted historical
digests; `Get-Diff.ps1` target validation; `Get-TurnContext.ps1` target validation,
source-floor comparison, and envelope emission; `companion/AGENTS.md`-guided chat
sessions through the turn-context envelope; the shared cycle commit guard used by
watcher, one-shot, and turn-context refreshes; and the watcher's cycle trigger. The two
pipeline readers may first inspect a narrow prefilter containing `source.domainId`,
`source.savedAt`, `source.saveFile`, `schemaVersion`, `adapterVersion`, and `game`, but a
prefilter pass gains no authority: the exact frozen bytes must pass complete core and
adapter admission before they can suppress a cycle or discard a candidate. Adapter
mappers are producers of this shape, not consumers. No other consumers.

The differ consumes: `schemaVersion`, `adapterVersion`, `game`, `generatedAt`, and all
five `source` provenance fields (for the 7.1 invalidation check and the 7.2 envelope);
`session.day`, `session.time`,
`session.location`; `character.level`, `character.xp`, `character.money.minorUnits`
(with `minorUnitsPerUnit` for delta emission and compatibility, plus `currency` for
compatibility), `character.skills` (name and value per
entry); `objectives[]` and their `subobjectives[]` (id and status, flattened per 7.2);
`inventory.owned` and `inventory.equipped`; and every leaf under `extra` except subtrees
excluded via adapter.json `diffExcludePaths` (7.2). `Get-Diff.ps1` additionally reads
the envelope fields (`schemaVersion`, `adapterVersion`, `game`) directly for its own 7.1
invalidation and upgrade checks, not merely as a conduit, and the section 8 post-digest
validator reads `schemaVersion`, `adapterVersion`, `game`, and all five `source` provenance
fields on the fresh digest before
commit; both are
part of the closed consumer list above, not additions to it.

The differ deliberately omits value deltas for: `session.playtimeNote`,
`character.unspentPoints`, `character.vitals`, `character.skills[].group`,
`inventory.highlights`, objective titles and timestamps, and `source.*`. Rationale, since
this core-level list is fixed schema semantics (unlike `extra`, whose noise tuning is
adapter data): vitals and highlights churn with nearly every save (combat and check
damage; inspection badges) and would bury real changes; unspentPoints follows level;
group is a static label; titles and timestamps are immutable once an
objective exists, so id and status carry all change signal; playtimeNote and `source.*`
identify the save, not the game state. The source-identity consumers in the complete
list above still read `source.*`; only game-state comparison ignores it. The diff copies
the current digest's complete source provenance so a host can bind the diff to its target.
`character.money.amount` is a validated display derivation of represented
`minorUnits`, while `currency` and `minorUnitsPerUnit` are pairwise compatibility
metadata; none of those three participates in the unrepresented-change projection.
Omitted game-state fields still participate in 7.2's
`hasUnrepresentedChanges` projection, so their transition is detected even though no
value delta is retained. Source and generation metadata do not participate in that flag.
Skill names present on only one side are emitted as additions or removals per 7.2 rather
than ignored.

Schema version 2 adds the acquisition-domain identifier, verified byte receipt, the closed diff contract,
unrepresented-change detection, and JSON Pointer paths in 7.2.
Every `schemaVersion: 1` `current.json`, `baseline.json`, and derived diff is version-stale under
7.1: the newest save is reprocessed once, the baseline is reset rather than compared
across schemas, and no adapter-version bump is required because the semantic change is
owned by core. Installation supplies the same adapterVersion's new schema-qualified
release before activating the new core schema; release identity therefore has a core
schema dimension even when adapter semantics do not change.


### 7.2 Diff shape

```jsonc
{
  "schemaVersion": 2,
  "adapterVersion": 2,
  "game": "disco_elysium",
  "hasChanges": true,                             // represented gameplay delta exists
  "hasUnrepresentedChanges": false,                // ignored or excluded game-state fields changed
  "baselineGeneratedAt": "...",                    // null when no baseline existed (first run / invalidated)
  "currentGeneratedAt": "...",
  "currentSource": {
    "domainId": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "saveFile": "...",
    "savedAt": "...",
    "byteLength": 1048576,
    "contentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  },
  "sessionChange": { "from": { "day": 3, "time": "23:46" }, "to": { "day": 4, "time": "08:09" },
                      "locationChanged": true },
  "objectives": {
    "added":         [ { "id": "...", "status": "active", "parentId": null } ],
    "removed":       [ { "id": "...", "lastStatus": "active", "parentId": null } ],
    "statusChanged": [ { "id": "...", "from": "active", "to": "done", "parentId": null } ]
  },
  "character": { "levelDelta": 0, "xpDelta": 12, "moneyDelta": -3.50,
                  "skillChanges": [ { "name": "Logic", "from": 7, "to": 8 },
                                    { "name": "New Skill", "from": null, "to": 3 } ] },
  "inventory": { "gained": ["id"], "lost": ["id"], "equippedChanged": true },
  "extraChanges": [
    { "path": "/extra/thoughts/fixed", "fromPresent": true, "toPresent": true,
      "from": ["id"], "to": ["id", "other_id"] },
    { "path": "/extra/reputation/kim", "fromPresent": true, "toPresent": true,
      "from": -4, "to": -2 }
  ]
}
```

`Read-DiffDocument` owns the complete core diff validator and always materializes through
`Read-CompanionJson` budget `diff`. It uses the same
ordinal, case-sensitive exact-field, timestamp, numeric, and no-coercion rules as
`Read-DigestDocument`. It returns the same validated `CompanionJsonValue` on success, throws a typed
structural validation exception on failure, and never calls `exit` or returns a partial
document. The required surface is:

| Path | Required type and invariants |
|---|---|
| Root envelope | Object containing exactly integer `schemaVersion`, integer `adapterVersion`, non-empty string `game`, Boolean `hasChanges`, Boolean `hasUnrepresentedChanges`, canonical UTC `o` string-or-null `baselineGeneratedAt`, canonical UTC `o` string `currentGeneratedAt`, object `currentSource`, object-or-null `sessionChange`, and object/array children `objectives`, `character`, `inventory`, and `extraChanges`. |
| `currentSource` | Exact five-field source provenance from 6.1. It identifies the acquisition domain and digest used as the comparison target. |
| `sessionChange` | Null or object containing exactly `from`, `to`, and Boolean `locationChanged`. `from` and `to` each contain exactly integer `day` and valid `HH:mm` string `time`. The object is legal only when day, time, or location changed; day and time equality requires `locationChanged: true`. |
| `objectives` | Object containing exactly arrays `added`, `removed`, and `statusChanged`. Across all three arrays the ordinal composite `(parentId, id)` is unique. Null parent sorts before strings. |
| `objectives.added[]` | Object containing exactly non-empty string `id`, valid status `status`, and non-empty string-or-null `parentId`. |
| `objectives.removed[]` | Object containing exactly non-empty string `id`, valid status `lastStatus`, and non-empty string-or-null `parentId`. |
| `objectives.statusChanged[]` | Object containing exactly non-empty string `id`, differing valid statuses `from` and `to`, and non-empty string-or-null `parentId`. |
| `character` | Object containing exactly integer `levelDelta`, integer `xpDelta`, finite decimal `moneyDelta`, and array `skillChanges`. |
| `character.skillChanges[]` | Object containing exactly non-empty string `name`, integer-or-null `from`, and integer-or-null `to`. Names are ordinally unique. Exactly one null means addition or removal; when neither is null the values must differ; both null is illegal. |
| `inventory` | Object containing exactly ordinally unique non-empty-string arrays `gained` and `lost`, plus Boolean `equippedChanged`. The two arrays are disjoint. |
| `extraChanges[]` | Object containing exactly non-empty string `path`, Boolean `fromPresent`, Boolean `toPresent`, and owned cloned `JsonElement` values `from` and `to`, within the standalone diff's maximum depth of 63. Paths are ordinally unique valid RFC 6901 JSON Pointers whose first decoded token is `extra` and which contain at least one further token. Empty tokens are legal. At least one presence flag is true; a false flag requires the corresponding value to be null; when both are true the values must differ under `JsonElement.DeepEquals`. |

`sessionChange` retains day and time endpoints because they date the transition for recap
consumers. Location deliberately retains only the fact of movement: the paired current
digest already supplies the destination, no current consumer needs the origin, and
adding `from.location` and `to.location` was rejected as duplicate payload surface.

Every collection has deterministic ordering: objective buckets sort by parent-id nulls
first, then parent id and id ordinally; skills and inventory ids sort ordinally; and
`extraChanges` sorts by path ordinally. The validator rejects non-canonical order as
well as duplicates. `hasChanges` is recomputed rather than trusted: it is true exactly
when `sessionChange` is non-null, any objective bucket or `skillChanges` is non-empty,
any character delta is nonzero, either inventory array is non-empty,
`equippedChanged` is true, or `extraChanges` is non-empty. When
`baselineGeneratedAt` is null, every change surface must have its canonical empty value
and both change Booleans must be false because a reset does not claim knowledge of the prior
state.

`Read-DiffDocument` cannot recompute non-reset `hasUnrepresentedChanges` from the diff
alone because the omitted before and after values are deliberately absent. It validates
that the field is Boolean and requires false on a baseline reset, but otherwise treats
its value as producer-owned. `Assert-DiffSemantics -Diff <document> -Baseline <digest>
-Target <digest> -AdapterConfig <validated AdapterCompatibilityConfig>` is the producer-side semantic
validator. It recomputes `hasChanges`, `hasUnrepresentedChanges`, exclusions, and every
emitted bucket from the digest pair, throws `CompanionDiffSemanticException` on any
mismatch, and returns no sentinel. Every pipeline, consuming, and walk-back differ calls
it before emission or state mutation; standalone cache and envelope readers perform
structural validation only.

The canonical omitted-field projection is closed. It compares
`session.playtimeNote` and `character.unspentPoints` as scalar JSON values; vitals by the
ordinal union of `name`, with presence and `value` significant; and
`inventory.highlights` as an ordinal set. For skills present under the same ordinal name
on both sides it compares `group`; a one-sided skill contributes only its represented
skill addition or removal. For objectives present under the same `(parentId, id)`
composite on both sides it compares `title`, `acquired`, and `resolved`; a one-sided or
reparented objective contributes only its represented objective bucket. Source,
generation, version, `money.amount`, `currency`, and `minorUnitsPerUnit` do not
participate. Adapter exclusions contribute only through the effective exclusion rules
below. Presence inequality or value inequality under `JsonElement.DeepEquals` in any
projected member sets `hasUnrepresentedChanges` true. This flag is independent of
`hasChanges` and may accompany either value. A consuming read may advance baseline
without retaining the omitted values, but it no longer silently loses the fact of a
transition.

Objective comparison keys top-level objectives by `(null, id)` and subobjectives by
`(parentId, id)`. A top-level id may equal a subobjective id, and the same subobjective
id may appear under different parents, without collision or loss. A subobjective moved
between parents emits one removal under the old composite and one addition under the
new composite. Bucket semantics are otherwise ordinary: added is current-only, removed
is baseline-only, and statusChanged is present under the same composite with differing
status. A removed objective, negative delta, or backwards session clock is expected
when the player loads an older save. A negative `xpDelta` alongside a positive
`levelDelta` is also normal forward play because `character.xp` resets on level-up.

`inventory.gained` and `lost` compare `inventory.owned` sets;
`equippedChanged` compares `inventory.equipped` sets. It intentionally retains only the
change fact: the paired current digest is the authoritative current loadout, while the
diff does not preserve prior loadout history. Owned-item acquisition and loss remain
itemized because those identities are the change itself. Character deltas come from
`level`, `xp`, `money.minorUnits`, and skills keyed by ordinal name. One-sided skill
names emit nullable additions or removals. Because validated `level` and `xp` are each in
the closed range 0 through Int64 maximum, current minus baseline is always representable
as signed Int64 in either direction. Before money comparison, baseline and current
must have ordinally equal currency and identical `minorUnitsPerUnit`; mismatch throws
`CompanionDiffCompatibilityException` before payload emission or baseline mutation.
`moneyDelta` converts both validated Int64 `minorUnits` values to
`System.Numerics.BigInteger`, subtracts there, converts the exact difference to Decimal
with checked conversion, and divides once by the validated positive Decimal
`minorUnitsPerUnit`. It emits the result as a Decimal using shortest round-trip decimal
serialization. Int64 subtraction, Double conversion, and subtraction of already-divided
values are forbidden.

`extraChanges` is game-neutral and lossless. The differ walks the validated digest
`RootElement` trees rather than their PowerShell materializations. Each present `from`
or `to` value retained in an entry is an owned clone of the corresponding `JsonElement`;
`ConvertTo-CompanionJson` writes it directly through `JsonElement.WriteTo`. The differ
walks objects recursively by the ordinal union of keys. Arrays are leaves and compare as sequences, so order and
multiplicity changes are retained in raw `from` and `to` values. A type change, scalar
change, null change, or one-sided path also emits raw values with presence flags that
distinguish absent from explicit null. An added or removed empty object emits at that
object's path because recursion would otherwise have no leaf. Paths use RFC 6901 JSON
Pointer encoding: `/` separates reference tokens, `~` becomes `~0`, `/` inside a key
becomes `~1`, and dots have no special meaning. Therefore literal key `a.b`, nested keys
`a` then `b`, slash-containing keys, tilde-containing keys, and empty keys remain
distinct. Equality uses
`System.Text.Json.JsonElement.DeepEquals`: object property order is insignificant,
array order and multiplicity are significant, strings compare ordinally, and numeric
spellings with the same JSON number value compare equal. Paths in adapter.json
`diffExcludePaths` suppress the named diff-addressable node and its complete subtree by
decoded, case-sensitive reference-token match. A configured pointer is
diff-addressable for one digest pair only when the object walker can visit that exact
node before emitting an atomic ancestor: every strict prefix below `extra` that is
present on either side must be an object, and at least one side must contain the target
node or a descendant reached through a one-sided object. Arrays, scalars, nulls, and
cross-side type changes are atomic leaves. A pointer descending through one is valid
RFC 6901 configuration but unresolved for diff purposes; it cannot suppress raw content
inside the emitted ancestor and does not contribute to `hasUnrepresentedChanges`.
Resolution runs independently for every configured pointer against the unpruned raw
baseline/current pair before any subtree is suppressed. A pointer therefore remains
resolved when a configured ancestor also resolves. After all pointers are classified,
the differ forms the suppression frontier by dropping each resolved pointer that has a
resolved strict ancestor. Filtering and omitted-change projection use that frontier;
unused-path warnings are produced only for pointers that failed independent raw-pair
resolution, not for resolved descendants removed from the frontier. Configuration order
cannot change resolution, warnings, emitted changes, or `hasUnrepresentedChanges`. A
pointer unresolved for diff purposes on the pair earns one typed
`diff-exclude-path-unused` warning per diff computation. The caller adds it to its
operation-wide typed sink, which deduplicates `(code, detail)` before an entry point
renders stderr or turn-context carries `warnings`. To exclude an array change,
configuration names the array node itself, such as `/extra/list`, never an element
beneath it.

The canonical empty diff is the full envelope with the target's `currentGeneratedAt`
and `currentSource`, both change Booleans false, `sessionChange` null, empty arrays in every
bucket, zero deltas, and `equippedChanged` false. Every emission site writes or prints
this exact shape; consumers validate with `Read-DiffDocument` and then test
the appropriate change Boolean, never file size or absence. Guidance uses `hasChanges`;
diagnostics may also inspect `hasUnrepresentedChanges`. When a diff is paired with a digest, the host
also requires `currentGeneratedAt` to equal `state.generatedAt`; the four
`currentSource` string fields equal `state.source` ordinally and `byteLength` equals it
numerically. Neither timestamp nor receipt alone is treated as sufficient.

Complete validator ownership is closed. The differ runs both `Read-DiffDocument` and
`Assert-DiffSemantics` on every document it creates before an emission or state write.
A structurally or semantically invalid generated diff is `[compute]` in the shared
consuming operation, `[compare]` in walk-back, and a cache-phase failure in the pipeline.
`Read-TurnContextEnvelope` and `Read-WalkResultDocument` each structurally validate any
populated nested diff again and map failure to their respective `[protocol]` path; neither
can recreate producer-only omitted values. A persisted
`diff-since-last-read.json` is diagnostic only; any future
manual or presentation reader must call `Read-DiffDocument`, treat rejection as absent,
and allow the next pipeline or consuming operation to repair it. No consumer accepts a
partially validated diff.

