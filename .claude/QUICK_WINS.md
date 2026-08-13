# Quick wins

Refactors ready to land when time allows; not blocking any feature, but
would improve the codebase meaningfully.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `FEATURES.md`, `BUGS.md`, `PATTERNS.md`). Active
entries are kept inline, organized under thematic `##` sections you
invent as work emerges. When a quick win lands, append a shipped-note
entry to [`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md); do not move
it within this file. Negative-knowledge findings (approaches attempted
and reverted) are first-class promotion candidates from the history
into the relevant `.claude/patterns/<slug>.md` Cautionary tales sections.

Capture shorthand: name the refactor, describe the current smell in a
sentence or two, sketch the preferred shape. A reader should be able to
start work from the entry alone. Anchor entries on identifiers that
survive refactors -- symbol names, entry titles, commit hashes, config
keys -- never on line numbers, plan-phase ordinals, bullet positions,
or temporal qualifiers ("new", "recent"): a precise locator that rots
misleads harder than a coarse one that holds.

**After adding a new entry, run `/nightshift:ready`** from the repo root
to confirm it parses as a quick-wins work item against the real grammar
in `skills/ready/ready.js`. Quick wins carry no `**Requires:**` line; the
failure mode to catch is an entry that doesn't parse as a `- ` bullet or
`###` heading (ready reports it as a prose-only-section notice) while you
can still fix it in the same session.

## Section 11 verification fixtures (deferred)

Three Section 11 claims remain un-wired because their fixtures need cross-process
concurrency or live plumbing beyond the scratch unit harness. Deferred by user
disposition 2026-08-11; the v2 cutover completed 2026-08-13, so each is now
unblocked authoring work.

- **Concurrent consume-lock fixture for claim 40 (Equal-identity target freeze).**
  Needs two genuinely concurrent consumers racing on the real `consume.lock` with a
  pause barrier between freeze-current and publish-baseline, a cross-process /
  time-ordered concurrency fixture the single-process unit harness cannot drive without
  simulating the concurrency. The single-process equal-identity retention half is
  already covered by the Watcher `EqualIdentityRetention` selector.
  Requires: none.

- **Staged wrapper fixture for claim 41 (Turn-context failure injection).** Needs a
  staged wrapper/acquisition fixture: private attempt A returns
  `[reset-write:not-consumed]`, a newer save lands, B consumes the newer target, only B
  reaches stdout, A is discarded; plus the failure-injection boundary matrix.
  Requires: none.

- **Staged acquisition fixture for claim 42 (Acquisition retry taxonomy).** Needs
  baseline-write-failure injection and multi-attempt cross-process declines beyond the
  scratch unit harness. The wrong-envelope-to-`[protocol]` recognition half is already
  covered by the TurnContext `EnvelopeProtocolRejection` selector and the wrapper
  terminal selection by `WrapperRetry`.
  Requires: none.

- **Execute the two provisional live-claims (section 11 rows 56 and 59).**
  Save-write stability and historical-save immutability passed verification only as PROVISIONAL
  because their preconditions need the game RUNNING (and, for immutability, cloud sync
  enabled): observe at least one live autosave pass the two-sample stability gate with
  zero unzip failures across a session producing 5+ saves, and confirm older matching
  candidates keep hash/size/mtime across later saves in every save mode. The probe
  selectors live in `core/tests/Test-Section11LiveProbes.ps1` (`Section11-56` /
  `Section11-59`), which is deliberately outside the `-Group All` dispatcher because its
  probes touch the real SaveGames; run them directly during a play session and then
  replace the spec's two `(live-claim: deferred 2026-08-11)` markers with the probe
  results.
  Requires: a window with the game running (user-scheduled).

## Version control / repository migration

- **Move the companion from the AppData sibling to `C:\Git\disco-elysium-companion`.**
  The companion was git-ified in place 2026-08-13 (private GitHub repo
  `astenlund/disco-elysium-companion`); its preferred long-term home is `C:\Git\`, per
  the machine convention for repo clones. Before moving, confirm the relocation breaks
  nothing: `adapter.json`'s absolute `saveDirectory` should survive, but re-verify that
  no acquisition path relies on `..\SaveGames\` resolving from the companion root. The
  move also changes the Claude/Codex project identity: the auto-memory directory,
  session directories, and `SessionStart` hook wiring are keyed to the current AppData
  path and need re-establishing from the new location before the old path is retired.
  Requires: none.

## State-extraction-v2 review tech-debt (deferred from the 2026-08-12 revise pass)

The full `/nightshift:revise-code` over the schema-v2 state-extraction changeset converged
(phase 1 and phase 2, all 63 dimension cells inactive). The confirmed defects were fixed and
gate-verified; the items below are the acknowledged lower-severity duplication / dead-code /
single-source / dormant-harness findings deferred to this backlog during the review. The
formerly cutover-gated review items all landed with the 2026-08-13 cutover and Task 16
verification: the 12 live/Go section-11 rows were wired to genuine live probes and passed,
the immutable `releases/2/schema-2` bundle was re-staged and installed, and the
save-read-only probe executed against the activated runtime. Only the 3 turn-context
fixture rows (claims 40-42, the deferred entries at the top of this file) remain.

- `WatcherCurrentReadResult`'s `adapter-invalid` status is dead (no producer emits it);
  `TurnContextPayloadCandidate.MarkSerialized`/`Invalidate` are dead code.
- `Test-Watcher.ps1` rebuilds the seven-scriptblock `WatcherRuntimeServices` bundle ~19 times;
  `Test-Walk.ps1` and `Test-AdapterConfig.ps1` repeat fixture constructors; `Test-Acquisition.ps1`
  couples an ordering test to literal source text; `Test-Build-Digest.ps1` repeats the
  skill_key_map load; `Test-TurnContext.ps1` `-Only` previously advertised a ghost `ConfigDrift`
  (now removed).
- Dump-tool: the TLV projected-key format and the TLV top-level table count (5) are each
  duplicated across `parser/lua_parser.go` and `main.go`; `findVariableStore` materializes a full
  `StringMap` of every table; `validateJSONMember` makes a full extra copy; `archive.go` binds
  `requiredSuffixes` order to the `memberKind` iota; `lua_parser.go` exports the unused cursor
  field.
 Landed 2026-08-12 since the prior revise pass: evidence-adoption content binding
  (per-name artifact validators + producing-input fingerprints), smoke-receipt `.next` sibling
  adoption, `ExecuteSmoke` sibling adoption, the static-hygiene forbidden-token failure, the
  retirement legacy-test wiring, and WriteThrough durability for the remaining aux writers; all
  verified by the passing cutover crash-matrix suite where suite-exercised. No open tracked bugs
  remain (`mapper-reputation-observability` resolved via option-b; the named
  duplicate-vendor/misspelled/bad-initial clauses are spec-deferred).

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
