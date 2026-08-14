---
status: exploring
---

# TUI companion app

A terminal app that wraps the companion in a refined interactive experience,
hiding the plumbing (watcher terminal, state refresh, Get-Diff consumption,
stderr classes) and keeping a Claude session alive behind the scenes for the
whole play session.

## Ownership boundary

The TUI is a presentation client of the
[companion execution runtime](companion-execution-runtime.md). It renders chat,
freshness, errors, dialogs, notices, objectives, plans, and deferred results. It
invokes runtime and domain commands but does not consume diffs, supervise workers,
write domain transitions, or filter raw internal knowledge itself.

The runtime owns agent and process lifecycle. Adaptive guidance owns research
records, spoiler projection, and deferred-work transitions. The shared contract
is [Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Candidate slices

These are provisional design seams while the feature remains Exploring. They are
not the formal `**Slices:**` block consumed by `/nightshift:ready`.

### Terminal shell

Provide streaming chat, live freshness and classified error status, a current
state header, a landing brief, and basic native single-select dialogs. Begin with
one adapter and a neutral theme. Consume runtime-projected state and interaction
events rather than invoking state-core writers directly.

This is the likely TUI MVP once the runtime coordinator contract is firm.

### Advanced dialogs and session-plan pane

Add batch flows, richer per-option notes, persistent plan presentation, and the
remaining native interaction affordances beyond the basic dialog surface.

### Deferred research inbox

Render projected user-requested tasks, readiness indicators, navigation, and
consume commands. The adaptive domain service remains the writer for queued,
researching, ready, and consumed transitions.

### Per-adapter theming

Apply adapter-owned palette and artwork data with graceful terminal color
degradation. This follows adapter catalog and theme-contract design rather than
blocking a neutral single-adapter shell.

Terminal bitmap images extend this slice beyond ASCII/Unicode motifs (idea
captured 2026-08-15). Target terminal graphics generally with protocol
detection: sixel (Windows Terminal 1.22+), kitty graphics protocol, iTerm2
inline images, degrading to the existing ASCII/Unicode motif fallback when no
protocol is available. Assets are user-provided or agent-fetched online;
SteamGridDB is the natural fetch target and its category set (grid, hero,
logo, icon at standard sizes) is the model for a per-adapter asset convention,
so a user dropping in files and the agent fetching them land in the same
slots. Placement is deliberately open: both branding surfaces (landing screen,
header, empty states) and contextual art (portraits, location or item imagery
tied to game state) are in the design space; contextual art must respect the
spoiler projection boundary if it keys off game state.

### Per-question model effort control

Expose a temporary stronger-reasoning action that reverts after one question.
Keep model configuration in the runtime and the keybinding and feedback in the
TUI.

## Architecture sketch (from the 2026-08-08 discussion)

- **Session connection: Claude Agent SDK** (TypeScript or Python). The runtime
  uses the same engine as Claude Code (tools, CLAUDE.md loading, session model)
  as a library and exposes one persistent streaming session per play session.
  Session ids allow resume across app restarts and across days. Auto-compaction
  handles context growth. Fallback option: the runtime shells out to
  `claude -p --resume <session-id>` with JSON streaming output per question
  (simpler wiring, process-spawn latency per turn, less mid-turn control).
- **Plumbing becomes runtime internals.** The runtime supervises the watcher
  loop, state hydration, refresh, and consuming Get-Diff operations. The TUI
  opens immediately while those operations happen asynchronously.
  State-dependent questions wait for a valid snapshot and answer as soon as
  it arrives; state-independent conversation remains available during
  hydration. Save events refresh the snapshot in the background, and the UI
  shows its freshness state rather than implying stale data is current. The
  stderr classes ([stale-current], [reset-write], ...) render as status-bar
  states instead of raw lines.
- **Adapter enumeration.** The runtime hosts `core/` and catalogs
  `adapters/*/adapter.json`; the TUI renders that catalog as its game menu.
  The core/adapter seam as implemented is already shaped for the "single
  companion app with a growing list of game-specific adapters" direction.
- **Pre-warmed first response.** The work the first question currently pays
  for moves to runtime startup and idle time: spawn the session, refresh
  state, and create a durable pending event for the consuming diff before the
  user types. The event survives a runtime, session, or TUI restart until its
  projected brief is acknowledged. First-response latency then approaches
  plain chat latency without relying on model context as the only copy of a
  consumed diff. Natural landing screen: the projected situation brief
  pre-rendered before the user types, so summoning the app greets the player
  with the lay of the land.
- **Idle-aware recap: walk back to the last eventful save.** Idling the game
  stacks autosaves with no changes between them, and pre-warm consumption
  advances the baseline through each of them, so "since last read" can be
  truthfully empty while the last real progress sits several saves back.
  This is now a specified core capability, not presentation logic: the runtime invokes
  `core/Find-LastEventfulSpan.ps1` (spec section 7.4) and consumes its JSON
  contract (found/boundHit/span/diff, with the UNEVENTFUL predicate,
  ambient-path tolerance, and bounds all owned by the script), framing the
  landing brief around the returned span. Runtime knobs reduce to the script's
  `-MaxSaves`/`-MaxAgeHours` parameters; the TUI decides how to present dry
  results. The game's autosave rotation limits how far back the disk can answer.
- **Deferred research inbox.** The companion's
  [adaptive guidance knowledge](adaptive-guidance-knowledge.md) feature may
  create durable result records for research the user explicitly asks to receive
  later. The TUI presents only those user-initiated records, marks ready results,
  and provides a keybinding to jump to and consume the next one. Silent warm-start
  and save-triggered enrichment stays out of the inbox.
- **Native dialogs.** In an SDK host, tool calls surface to the host app, so
  AskUserQuestion becomes a dialog the TUI renders itself: own keybindings,
  per-option notes UI, a persistent session-plan pane built from selections.
  Probed 2026-08-08: the stock CLI's single-select preview dialogs render
  generously (32+ lines, 100+ columns, working per-selection notes), which the
  sequential guidance flow now uses; the native-dialog payoff is therefore
  batch/multiSelect flows with notes, richer layout than the flattened-markdown
  preview pane, and persistent panes, not basic notes support (the annotations
  field exists in the tool result schema for a host to populate).
  Also enables a live header (day/time/location, vitals, money from
  current.json) and a spoiler-safe objective board.
- **Stack lean: TypeScript + Ink + Agent SDK** (Ink is what Claude Code's own
  TUI uses; one language for UI and session control). Alternative: Go with
  Bubble Tea to match the dedump toolchain, talking to the session via the
  headless CLI or a small TS sidecar. The PowerShell core stays untouched as
  the state layer the app invokes.
- **Per-game theming.** The active adapter styles the app: a theme block
  (adapter.json key or sibling theme file) supplies a color palette and
  optionally basic artwork (an ASCII/Unicode motif or logo for headers and
  empty states), so the companion looks native to the game it is following
  rather than generic. Theming is data the adapter ships, like the dump and
  digest commands, so each new game brings its own look; the app carries a
  neutral fallback theme for adapters that ship none. Terminal constraints
  apply (palette degrades gracefully from truecolor to 256/16 colors).
  Bitmap artwork via terminal graphics protocols layers on top of this;
  see the Per-adapter theming candidate slice for the captured design
  notes (protocol detection, asset sourcing, placement).

## Why a TUI and not an Electron-style app

The decisive interaction pattern: a TUI is summonable as a fullscreen drop-down
console via Windows Terminal quake mode, one keystroke over the running game and
one keystroke away again, exactly like the classic quake console. An Electron
app competes with the game for screen space and alt-tab attention; the quake
overlay makes the companion feel like part of the game's own surface. Secondary
benefits: negligible resource footprint next to a running game, and terminal
rendering is the native habitat of the underlying session anyway.

## Known costs and open questions

- The current setup gets the full interactive Claude Code environment free
  (skills, memory, conversation continuity). An SDK host recreates only what
  it configures: system prompt, allowed tools, and the companion CLAUDE.md
  need explicit wiring. Straightforward, but that is where the effort goes.
- The user intends to split dev and exec workflows (developing the companion
  vs. using it during play) either when building the TUI or before it; the
  app is naturally the exec side of that split. The app defaults to Sonnet
  at medium effort (the machinery does the heavy lifting; latency is the
  felt experience; spoiler discipline rules out the smallest tier) and
  offers a "think harder" mode, a keybinding that bumps to Opus at high
  effort for open judgment calls like build walkthroughs. Decided
  2026-08-08: the bump is per-question and auto-reverts; a sticky bump
  would silently tax every subsequent quick question. Dev sessions stay on
  the strong tier.
- Undecided: auth/runtime packaging (SDK uses the same login as the CLI),
  and whether the watcher-derived save-event stream should proactively
  surface notable changes in the UI between questions.
