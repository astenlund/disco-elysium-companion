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

The three deferred fixture claims (40, 41, 42) all shipped 2026-08-13; see
QUICK_WINS_HISTORY.md. Claim 41's residual halves ride the three reason-taxonomy
bugs in BUGS.md, and claim 42's stability and gate-disappearance retry classes
ride the post-lock stability-gate bug there. Only the live-claims probe below
remains, gated on a play session.

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

## Turn-context internals

- **Decompose Invoke-TurnContextAttempt.** One body of roughly 92 lines
  (`core/private/TurnContext.ps1`) mixes init/reaper, the refresh retry loop,
  lock/config/cycle handling, consumption/envelope emission, and terminal-result
  construction (revise-code confirmed finding, 2026-08-13). Best done AFTER the
  BUGS.md reason-taxonomy and stability-gate fixes land, since they rework the
  same terminal sites; decide then whether `New-TurnContextTerminalResult`
  hoists to file scope as part of the decomposition.
  Requires: none.

Implemented quick wins are archived in
[`QUICK_WINS_HISTORY.md`](QUICK_WINS_HISTORY.md), read only when
consulted (not at session start) so the active backlog above stays
scannable. When a quick win lands, append its entry there rather
than to this file.
