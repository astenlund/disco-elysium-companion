# Features (history)

Implemented features, archived from `FEATURES.md` so the active backlog stays scannable on session start. **Archaeological**: read only when consulted, not at session start. When a feature (or a slice of a sliced feature) ships, append its entry here rather than to the active file.

The feature breakout file at `features/<slug>.md` stays in place as the historical design record; the entry here is a brief one-line note on what shipped and in which feature scope or commit. If follow-up work on the same feature changes the design meaningfully, prefer editing the original breakout file (and adding a second entry here for the follow-up) over creating a new file.

## Cross-reference resolution

`/nightshift:ready` does **not** parse this file for work; only the line-discipline check reads it. When a feature ships, every other `**Requires:**` line in `FEATURES.md` / `BUGS.md` that referenced it is edited at the same time to drop the now-satisfied reference (see the convention in `FEATURES.md`'s `## Requires lines` and `## Slicing` sections). The active `Requires:` lines therefore describe what is *currently* blocking and the dependency graph settles as work ships. This file is purely archaeological; read it when you want to know what already shipped, not to resolve dependencies.

## Entries

- [State extraction tooling](features/state-extraction.md): the schema-v2 state-extraction core and Disco Elysium adapter completed cutover on 2026-08-13, with later hardening recorded in BUGS_HISTORY.md and QUICK_WINS_HISTORY.md. The retained design covers save dumping, digest mapping and admission, diff consumption, idle walk-back, validated turn acquisition, watcher operation, and the verification matrix. Its full contract and section anchors were absorbed from the former standalone spec into this shipped feature record on 2026-09-21; no new implementation work is implied.
- [Companion execution runtime: Single-session state coordinator (MVP)](features/companion-execution-runtime.md): local dark slice of core consumer ownership and state-event outbox plus the single-session runtime, Claude provider, SessionHostV1 and text client; private bridge, restart and fixed 120-second gate checks passed on their recorded pre-publication inputs, while the bridge remains the default consumer and running-game cutover is unprobed.
