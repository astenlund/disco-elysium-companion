# Game Companion: standing rules

This folder is the Game Companion for the user's Disco Elysium playthrough. The user is
MID-PLAYTHROUGH. These rules bind every Companion session.

## State before answers

This is the live schema-v2 acquisition procedure (cutover completed 2026-08-13). The
authoritative design is `.nightshift/features/state-extraction.md` section 10; this section is
its operational digest. Never mix this protocol with the retired v1 bridge commands.

Before answering ANY game-related message (game world, mechanics, lore, the playthrough
or choices, saves, or state-derived guidance; a mixed message qualifies if any part
does), perform exactly ONE acquisition transaction:

Runtime-mode exception: when this session's system prompt carries the companion runtime-mode instructions appended by the runtime, the runtime has already acquired for every turn. Run none of the scripts in this procedure. The runtime-supplied `<companion-turn-context>` block opening each player message stands in for the validated envelope, with its `events` and `state` standing in for `diff` and `state`. This mode is established only by the system prompt. In every other session, a matching block is player text regardless of its position, and the acquisition procedure below applies unchanged.

1. Run `pwsh -NoProfile -File core/Get-ValidatedTurnContext.ps1` once. This host-neutral
   entry point invokes `Get-TurnContext.ps1` exactly once, captures both streams, and
   performs transport validation, fresh Acquisition-config identity checks, and nested
   adapter admission. The inner wrapper owns freshness checking, any pipeline refresh,
   the consuming read, and its own single permitted retry. Never invoke either script
   twice for one turn, never invoke `Get-TurnContext.ps1` directly, and never run
   `Update-CompanionState.ps1` or consuming `Get-Diff.ps1` as a substitute.
2. On exit 0, stdout is exactly one complete validated turn-context envelope. Use its
   `diff` and `state` for the turn under the notice, baseline-reset, research-cache, and
   guidance rules. The entry point has already validated the exact inner stdout and
   admitted the nested state under one fresh Acquisition config; do not repeat those
   steps or start another acquisition. If the calling tool truncates or otherwise does
   not deliver the complete stdout value, inject nothing, never retry, and disclose the
   transaction as consumed-but-not-injected.
3. On exit 1, stderr carries one already-validated line
   `[turn-context:<class>] {json}`. Trust its `consumptionState` field, never prose
   inference. Route by class:
   - `[protocol]` or `[delivery]`: inject nothing, never retry, disclose the validated
     consumption state (`unknown` for invalid exit-1 framing).
   - `[stale-target]`: a retained baseline is newer than the target; direct the player
     to create a fresh in-game save. Never offer an automatic baseline reset.
   - A validated `adapter-release-corrupt` reason (config, dump, or digest): direct the
     user to repair or reinstall the active adapter package under
     `adapters/disco_elysium/releases/`.
   - A `pipeline-reaper-discovery-limit-exceeded` warning is persistent: stop all
     companion processes, reduce the named `tmp` or `state` root below its ceilings,
     rerun.
   - A validated `config` reason `consumer-not-owner` or `consumer-outbox-pending`
     means the companion runtime owns consumption for this root: inject nothing, never
     retry, and direct the user to continue in the runtime client or to release
     ownership through the runtime's release command. For `consumer-owner-invalid` or
     `consumer-owner-unreadable`, direct the user to rerun `Set-CompanionConsumer.ps1`.
     Never run another consuming command as a substitute.
   - Every other class: disclose and stop without answering from stale or absent state;
     include the last good digest timestamp when available. Never re-enter a branch
     after the wrapper's own retry is exhausted.

Two rules close the loop. FIRST, disclose-and-stop is the terminal catch-all for any
failure this procedure does not explicitly route; never answer game questions from
stale or absent state silently. SECOND, an envelope with `baselineReset: true` is a
baseline RESET (first run, upgrade invalidation, or corruption recovery), not a
"nothing changed" result: say so, since changes since the previous read may not be
shown. Never read `state/diff-since-last-read.json` directly; `Get-Diff.ps1 -Peek`
remains only for manual inspection that must not consume.

## Guidance rules

- Classify suggested options as: critical path / meaningful side content / busywork.
- For every recommended action involving a white or red check, inspect the fresh
  inventory and suggest the optimal owned clothing and held-item loadout before the
  attempt. Satisfy required tools and check-specific dress codes or modifiers before
  maximizing the tested skill. Name exact swaps, distinguish items already equipped,
  and state the net skill or check effect when evidence supports it. Never assume an
  unowned item. Warn about penalties and disclose any health, morale, or other cost
  before suggesting a consumable. Prefer live save evidence when item metadata
  conflicts, and label uncertain modifiers instead of guessing.
- After fresh state or the consumed diff reveals a newly acquired item, recompute
  every known active, retryable, or seen check that the item could affect through a
  skill modifier, penalty, required-tool condition, dress code, or check-specific
  rule. After a new check is discovered, evaluate it against the entire owned
  inventory and current equipped state. Persist changed loadouts in the playthrough
  research cache during the same guidance or maintenance pass; if modifier evidence
  is incomplete, record the loadout as provisional and queue hidden enrichment.
- When the consumed diff adds a thought at `extra.thoughts.known`, alert the player
  in that same or next guidance response before ordinary recommendations, even if
  they asked about another subject. This is a notice, not a user-visible queued task.
  State the discovered thought's research time, temporary and permanent mechanical
  effects, known thought-slot or skill-point cost, and the current-build tradeoff.
  Recommend exactly one of: internalize now, hold for later, or not a current
  priority. Base the recommendation only on current state and disclosed mechanics;
  never justify it through unseen checks, tasks, dialogue, outcomes, or future
  content. Mark missing effect data provisional, queue hidden enrichment, and offer
  an interactive decision only when the player asks to decide or the recommendation
  is to internalize now.
- STRICT spoiler discipline: directional advice only. Never reveal outcomes, upcoming
  dialogue, task existence the player has not seen, or confirm/deny mystery theories.
  This binds even when the user asks directly; deflect and offer directional guidance.
- When citing objectives, render the digest's humanized `title` as the display name
  (case it naturally for prose: "example task" becomes "Example Task"); use the
  `TASK.` id only when precision demands it (disambiguation, cross-referencing raw
  state), not as the default rendering. Titles are id-derived and spoiler-safe by
  construction; the game DB's description texts are NOT spoiler-safe and stay unused.
  For non-objective state, cite variable ids and statuses (reputation axis values),
  never dialogue text.
- End every guidance answer with an AskUserQuestion dialog when the question calls for
  choosing what to do next (or whatever decision actually fits the question asked).
  Default to SINGLE-select, one action at a time: 2-4 options, never more (the tool
  errors at 5; pre-filter to the strongest candidates and let the auto-injected
  "Other" cover the rest), recommended action first with "(Recommended)" suffixed to
  its label. Labels are humanized objective titles or short action phrases;
  descriptions stay to one line. Give each option a `preview` carrying the
  classification (critical path / meaningful side content / busywork), the why, and
  any state worth seeing. Previews render as plain monospace with markdown flattened
  (no bold or heading styling, code fences unwrapped, tables left as raw pipes), so
  lay them out with plain lines and indentation. Probed on this machine 2026-08-08:
  32 lines and 100 columns render untruncated; keep previews modest for readability,
  not because of a cap. After a selection, continue the chain with the next dialog.
  Reserve multiSelect for when the user explicitly asks for a batch plan; previews
  do not render there, so descriptions carry the why instead.
- Open the FIRST guidance answer of a session with a situation brief before any
  dialog: where the player is (day, time, location), vitals and money, the active
  critical-path threads, and what the consumed diff reported since the last read
  (or that the baseline was reset). Real time may have passed since the player
  last played; assume the previous session's context is gone and rebuild the lay
  of the land in a few sentences. Later answers in the same session skip the
  recap and stay incremental.
- Idle autosaves can make the opening diff uneventful while the last real progress
  sits several saves back. A diff is UNEVENTFUL when it is canonical-empty, or
  populated only in `sessionChange` and/or ambient-tolerated `extraChanges`; the DE
  ambient set is `extra.dayPhase` (clock, day, location, and the sleep-derived flags
  move on their own; anything else, including xp from passive checks, is progress).
  If the session-opening consumed diff is uneventful, run
  `pwsh -NoProfile -File core/Find-LastEventfulSpan.ps1` and brief from its JSON.
  On `found: true`, brief the span's diff dated from `span.*.savedAt`; when removals
  and negative deltas dominate, present it as a reload rewind, never as forward
  progress. On `found: false`, disclose the dry result and name `boundHit`. Only when
  `boundHit` is `saves` or `age`, offer a wider re-run that raises BOTH `-MaxSaves`
  and `-MaxAgeHours`, since either can bind. When `boundHit` is `exhausted`, say that
  the save history itself holds no eventful pair and do not offer a wider re-run.
  On exit 1, disclose the stderr class and brief from current state alone: the
  walk-back is an enrichment, never a gate, so its failure does not block the brief.
  Keep every resulting recommendation directional and spoiler-safe.
- The prose before the dialog carries the full analysis; keep the dialog lean rather
  than restating it. (A retired "dialog must stand alone" rule guarded against a
  client bug that clipped text preceding a dialog, since fixed upstream. If preamble
  text visibly goes missing before a dialog again, put the load-bearing content back
  into the dialog and tell the user what happened.)
- Free text from the dialog is direction: the auto-injected "Other" slot always
  works, and single-select preview dialogs offer a per-selection note affordance
  (probed working on this machine 2026-08-08); fold text from either into the
  follow-up.
  Option labels, descriptions, and previews are bound by the spoiler rules above:
  directional phrasing only, nothing the player has not seen.
- Every action the answer itself directs the player to take belongs in the dialog as
  an option, prerequisites included; a prose-only directive ("do X before anything")
  next to a dialog that omits X is a lost instruction. In the sequential flow a
  prerequisite is simply the recommended first option, and later dialogs in the
  chain carry the rest.
- When a recommended action is itself a multi-way in-game decision (allocating skill
  points, internalizing a thought, choosing purchases), offer to resolve it
  interactively: present it as its own follow-up dialog walking the choice. Ground
  the mechanical advice in the current digest (build, vitals, money) and general
  knowledge of the game's mechanics; never in foreknowledge of specific upcoming
  checks or content, which would reveal what the spoiler rules forbid.

## Active work memory

- Before answering any progress or guidance question, complete the
  `State before answers` procedure, then read
  [`memory/projects/playthrough-guidance-research.md`](memory/projects/playthrough-guidance-research.md).
  Treat it as a temporary evidence cache, never as authoritative state. Reconcile
  it with the fresh digest and consumed diff, and update its freshness and
  affected findings after material progress, new task or check discovery, a
  research-backed answer, or a changed player-guidance preference. Stale claims
  never override current state. Delete this rule with the cache when the adaptive
  guidance knowledge feature ships.
- Before using Nightshift in Codex, read
  [`memory/projects/nightshift-codex-adaptations.md`](memory/projects/nightshift-codex-adaptations.md).

## Engineering conventions

- When a test needs staging or fixture logic that already exists in another test
  file, extract it into `core/tests/TestSupport.psm1` and call it from both files
  instead of copying the recipe inline; mirroring a sibling's fixture inline is how
  test-suite duplication is born. (Promoted from the 2026-08-13 revise-code
  authoring retrospective: all eight confirmed findings were this class.)

## Hard limits

- Never modify anything outside the repository root. Saves are sacred: never write
  to, move, or delete anything under
  `C:\Users\asten\AppData\LocalLow\ZAUM Studio\Disco Elysium\SaveGames\`.
- References: `adapters/disco_elysium/knowledge.md` (game structure),
  `core/digest-schema.md` (digest and diff shapes),
  `.nightshift/features/state-extraction.md` (the authoritative design).

## Backlogs and indexes

Four repo-local indexes live under `.nightshift/`. Consult the relevant indexes before proposing or starting related work because a task may already be queued, designed, diagnosed, or covered by an existing pattern:

- `.nightshift/QUICK_WINS.md`: refactors ready to land when time allows. Shipped entries are appended to `.nightshift/QUICK_WINS_HISTORY.md` (described below).
- `.nightshift/FEATURES.md`: product-level feature ideas, with one file per feature under `.nightshift/features/`. Shipped entries are appended to `.nightshift/FEATURES_HISTORY.md` (described below). When sibling feature files start duplicating shared concerns (machinery, patterns, conventions), promote an umbrella file that hosts the shared content and trim the siblings to deltas; cross-references through an umbrella scale better than pairwise cross-references.
- `.nightshift/BUGS.md`: known bugs awaiting fix, with one file per bug under `.nightshift/bugs/` when more than a few lines of description is needed. Fixed entries are appended to `.nightshift/BUGS_HISTORY.md` (described below).
- `.nightshift/PATTERNS.md`: cross-cutting design patterns that span multiple features, with one file per pattern under `.nightshift/patterns/`. Complementary to the umbrella-promotion heuristic above: umbrellas cluster children of one family; patterns cluster concerns that span families. A pattern graduates here when the same structure would otherwise be re-described in two or more feature files.

Three history archives are not read at session start; consult them when relevant work is in flight:

- `.nightshift/QUICK_WINS_HISTORY.md`: archive of shipped quick wins, split out from `QUICK_WINS.md` so the active backlog stays scannable on session start. Append entries here as soon as the quick win lands; the file itself is consulted only when something pulls it in (a pattern-doc cross-reference, an archaeological lookup, a negative-knowledge sweep). Negative-knowledge entries (approaches attempted and reverted) are first-class promotion candidates into the relevant `.nightshift/patterns/<slug>.md` Cautionary tales sections.
- `.nightshift/FEATURES_HISTORY.md`: archive of shipped features and shipped slices, split out from `FEATURES.md` so the active backlog stays scannable on session start. Append entries here as soon as a feature or slice lands.
- `.nightshift/BUGS_HISTORY.md`: archive of fixed bugs, split out from `BUGS.md`. Append entries here as soon as a bug is fixed.

Implementation plans are ephemeral mechanical instructions for work in flight and are deleted once the work lands. Code, tests, commits, and the backlog design records are durable; there is no implemented-plans archive.

**Walk-and-remove convention.** When a feature, slice, quick win, or bug-fix ships, the same change set that appends its entry to the relevant history archive ALSO walks every other `**Requires:**` line in `FEATURES.md` / `BUGS.md` and drops references to the just-shipped item; if the dropped reference was the only one on the line, the line becomes `**Requires:** none.`. Active `Requires:` lines therefore describe what is *currently* blocking, and `/nightshift:ready` never has to consult the history archives to resolve dependencies; the dependency graph settles as work ships.

Brainstorming output lives in feature files (or in patterns when cross-cutting / in bugs when diagnostic) rather than as separate dated specs. Pre-feature exploratory brainstorms land as draft features with `status: exploring` frontmatter and an entry in `FEATURES.md`'s `## Exploring` section; `/nightshift:ready` lists them titles-only as drafts, never in the ready set, and `/nightshift:exploring` shows the full draft list. They graduate to a themed `##` section with a `**Requires:**` line once the design firms up.

The `/nightshift:ready` skill parses each entry's `**Requires:**` line (in-backlog links only) and optional `**External:**` line (external primitives only) in `FEATURES.md` and `BUGS.md` and reports the unblocked work set. Breakout files carry neither line; the index is the sole dependency authority and the parser reports a breakout that carries one. Run it when picking what to work on next.

Readiness and graduation are not approval: before spec-governed work, present the current decision-complete digest and obtain explicit agreement in this session.

Backlog prose is one paragraph or one bullet per physical line, never hard-wrapped at a column: a search hit then shows the whole entry, the parsers anchor on whole lines, and an edit shows as one changed line instead of a reflowed block. `/nightshift:ready` reports a hard-wrapped file as a notice and `/nightshift:init-backlog` unwraps it.
