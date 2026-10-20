# Disco Elysium Companion

A local, spoiler-safe AI companion for a Disco Elysium playthrough. It reads the game's save files, turns them into a game-neutral JSON "digest", works out what changed since the last time you asked, and hands that to an AI agent session that gives directional guidance without revealing anything the player has not seen yet.

This is a personal, single-machine project built around one ongoing playthrough. It is published so others can read the design and reuse the save-parsing and state-diffing ideas, not as a packaged product. Expect Windows-only tooling, absolute paths in some configuration, and design records written for the author's own agent sessions.

> **Spoiler warning.** The documentation, the digest, the pipeline's diagnostics and the guidance are written to be spoiler-free: mechanical examples only, no dialogue, task names or plot variables. The raw dump that the Go tool produces is unfiltered save content, dialogue variables included; in the normal pipeline it stays in the scratch area, but if you run the tool by hand without an output path it prints all of it to the terminal. One tracked file is the other exception: `memory/projects/playthrough-guidance-research.md` is the companion's research cache for the current playthrough and contains quest timing, check details and route planning. Do not open it if you want to play blind.

## How it works

Disco Elysium writes saves as `*.ntwtf.zip` archives. Each one holds JSON files for the character sheet, journal, inventory and clock, plus a binary Lua file carrying roughly twelve thousand dialogue variables. The companion never writes to that directory. It opens an original save only to hash it and copy it into a scratch area, and checks that the original did not change meanwhile; unpacking and parsing operate on the copy.

From there the pipeline runs in four stages:

1. **Dump.** A small Go tool (`adapters/disco_elysium/dump-tool/`) unpacks the save copy and emits one complete JSON document. Its binary Lua parser is adapted from the open-source `disco-elysium-editor` project, with the deviations recorded in the design document and the upstream licence in `THIRD_PARTY-NOTICES.md`.
2. **Digest.** A PowerShell mapper (`adapters/disco_elysium/Build-Digest.ps1`) reduces that dump to a versioned, game-neutral digest: day and time, location, level and skills, money, vitals, objectives, inventory, and a game-specific `extra` block. Objective titles are derived from engine ids, never from journal text, so they are spoiler-safe by construction.
3. **Diff.** The game-agnostic core (`core/`) keeps the latest digest as `current.json` and a `baseline.json` snapshot from the last time the companion consumed state. Reading the diff is a consuming transaction: under one lock it computes what changed and rolls the baseline forward, so two readers cannot double-show or drop a change. What can still go wrong after that point differs between the two routes described below and is spelled out under "Design principles". If the baseline is missing or invalid, the core resets it and says so, because changes since the previous read may then be missing.
4. **Guide.** An agent session, in Claude Code or Codex or hosted by the runtime below, receives the fresh digest and the consumed diff and answers under the standing rules in `AGENTS.md`: classify options as critical path, side content or busywork, keep advice directional, and end with a choice of what to do next.

The split between `core/` and `adapters/` is deliberate. Nothing in the core implementation knows about Disco Elysium; only the core tests name the adapter, so that they can exercise the real one. Game-specific tuning reaches the core only as data in the adapter's `adapter.json`, which is what makes a second game adapter possible without touching the diff engine.

## Repository layout

| Path | What it holds |
|---|---|
| `AGENTS.md` | Standing rules for the companion's own agent sessions: the state-acquisition protocol, guidance rules and spoiler discipline. `CLAUDE.md` just points at it. |
| `core/` | Game-agnostic PowerShell: save watcher, one-shot state update, diff reader, turn-context acquisition, idle walk-back, consumer ownership and the state-event outbox. Tests live in `core/tests/`. |
| `core/digest-schema.md` | The digest and diff JSON shapes. |
| `adapters/disco_elysium/` | The Disco Elysium adapter: `adapter.json` configuration, the Go dump tool, the digest mapper and validator, vendored reference data, and `knowledge.md` with spoiler-safe notes on the save format. |
| `runtime/` | A Node and TypeScript coordinator that hosts one Claude Agent SDK session, supervises the core, journals state events durably and exposes a text chat client. See `runtime/README.md`. |
| `.nightshift/` | The project backlog and design records: feature designs, bug diagnoses, reports and shipped-work history. `.nightshift/features/state-extraction.md` is the authoritative design for the extraction pipeline. |
| `memory/projects/` | Working notes carried between agent sessions, including the spoiler-bearing research cache mentioned above. |

Some directories exist locally but are not tracked, by design:

- `state/` holds the live playthrough digests, baseline, locks and outbox. It is personal data and changes on every autosave.
- `adapters/disco_elysium/releases/` holds the installed, immutable adapter package that the pipeline actually runs. See "Setting up a fresh clone" below.
- `adapters/disco_elysium/dump-tool/dedump.exe` is a build output. `build.ps1` in that directory rebuilds it with `go build`.
- `.tmp/` is the scratch area for save copies and pipeline work files.
- `runtime-data/` holds runtime-owned journals and session bindings, partitioned by game and Windows user.

## Setting up a fresh clone

A fresh clone cannot process a save until two untracked pieces exist. The first is a build output; the second is copied by hand, since no script assembles it today.

1. **Build the dump tool.** Run `adapters/disco_elysium/dump-tool/build.ps1`, which produces `dedump.exe` next to the Go sources.
2. **Assemble the adapter release package.** The pipeline never runs the tracked adapter sources directly. It runs an immutable copy under `adapters/disco_elysium/releases/<adapterVersion>/schema-<schemaVersion>/`, so that editing the sources cannot change the behaviour of an already-configured install. Both versions are currently 2, so the package root is `adapters/disco_elysium/releases/2/schema-2/`. Inside it, create `core/` holding `DigestDiff.psm1`, `EntryFence.psm1` and the `private/` directory copied from the tracked `core/`, and `adapters/disco_elysium/` holding `Build-Digest.ps1`, `Validate-Digest.psm1`, `game_data/` and `dump-tool/dedump.exe` copied from the tracked adapter directory. The core refuses to run when the package or its validator is missing.

Then point `saveDirectory` in `adapters/disco_elysium/adapter.json` at your own save folder. The core fails closed with a classified configuration error until that directory exists.

## Two ways to run it

**Through an agent CLI.** Open the repository in Claude Code or Codex. `AGENTS.md` instructs the session to run `core/Get-ValidatedTurnContext.ps1` once before answering any game-related question. That script processes the newest save if needed, consumes the diff, validates the result and prints one JSON envelope for the session to use. This was the original mode. It is the default owner of state consumption on a fresh install, and it refuses to consume while the runtime below owns consumption, while runtime records are still pending, or while the ownership marker is unreadable.

**Through the companion runtime.** `runtime/` hosts a persistent Claude session of its own. Once it has been given ownership of state consumption, it keeps the save watcher running so current state stays fresh, acquires state at startup and before each chat turn that its journal and safety checks admit, journals every change durably before the model sees it, and after a restart replays only the changes whose delivery was never acknowledged. Install the dependencies, hand consumption to the runtime once, then start chatting:

```
npm --prefix runtime ci
node runtime/src/cli.ts consumer runtime
node runtime/src/cli.ts chat
```

`chat` refuses to start while something else owns consumption, which is what a fresh install reports until the `consumer runtime` step has run.

`runtime/README.md` documents the commands, configuration and recovery model, and `runtime/STARTUP.md` explains each startup phase it prints.

Only one of the two may consume state at a time. A marker in `state/` records the owner, and `core/Set-CompanionConsumer.ps1` and the runtime's `consumer` command switch it.

## Requirements

- Windows. The runtime and the core scripts use Windows-specific process and file primitives.
- PowerShell 7.5 or later (`pwsh`).
- Go 1.21 or later to build the dump tool.
- Node 22.23 or later for the runtime.
- A Disco Elysium installation. `adapters/disco_elysium/adapter.json` currently carries the author's absolute save path; the setup section above says how to change it.
- For the agent CLI route, a Claude Code or Codex login. For the runtime, a Claude Code login or API credentials; it uses the default Claude Code profile.

## Running the tests

Core and adapter tests are grouped PowerShell scripts:

```
pwsh -NoProfile -File core/tests/Invoke-StateExtractionTests.ps1 -Group All
```

Pass a single group name such as `Diff`, `Adapter` or `TurnContext` to run one slice. The dump tool has ordinary Go tests (`go test ./...` in its directory). The runtime has a type check and a Node test suite:

```
npm --prefix runtime run typecheck
npm --prefix runtime test
```

The runtime's integration tests build private companion roots under a scratch directory and drive the coordinator with a fake provider, so they need no real save and no credentials, but the native checks can take a long time.

## Design principles

- **Saves are sacred.** Nothing in this repository opens a file under the game's save directory for writing, and nothing moves or deletes one.
- **Account for every change.** Consuming the diff and advancing the baseline happen under an exclusive lock, so two readers cannot interleave and double-show or drop a change. The two routes differ in what happens after that. On the agent CLI route a change counts as consumed once the baseline advances, so a crash between that moment and the answer reaching the player can lose it; a failed baseline write, by contrast, is reported as not consumed and the change reappears next time. The runtime closes that window: it writes each change to a durable record before the model sees it, rebuilds a baseline that failed to advance from that record, and replays a change whose delivery was never acknowledged, marked as a redelivery so the model does not announce it as new again. In both routes a baseline reset is always disclosed.
- **Fail closed.** Any invalid digest, mismatched schema or adapter version, unreadable state file or unreadable save stops the pipeline with a classified error instead of guessing. Two conditions are repaired rather than fatal, and both are reported: a corrupt latest-state file is rebuilt from the save, and a missing or content-invalid baseline is reset, as described in the pipeline walkthrough above. The guidance layer discloses a failure rather than answering from stale state.
- **Spoiler discipline at every player-facing surface.** The digest, the diff, the pipeline's diagnostics and the guidance carry no dialogue, no unseen task names and no plot variables. Only the raw dump is unfiltered, and in the normal pipeline it never reaches the player. The guidance rules bind even when the player asks directly.

## Status and backlog

The extraction pipeline completed its cutover in August 2026 and is the layer the author's agent sessions acquire state through. The runtime was handed the real companion root on 2026-10-13 and has passed a live chat and restart smoke test; its remaining live claims (a new in-game save, crash redelivery and release back to the CLI path) are recorded as unprobed in `runtime/README.md`. Open work, exploratory ideas and known bugs are tracked in `.nightshift/FEATURES.md`, `.nightshift/QUICK_WINS.md` and `.nightshift/BUGS.md`. Future directions under exploration include a terminal UI, speech playback, an adaptive guidance knowledge base, and adapters for other games.

## Licensing

The adapted Lua parser carries the MIT licence of its upstream project; see `THIRD_PARTY-NOTICES.md`. Disco Elysium and its save data belong to their rights holders. This repository ships no game content beyond two small reference tables taken from the same upstream project: the reputation axes with their initial values, and the skill key map with its ability, equipment, inventory, modifier, thought-state and healing-pool enumerations.
