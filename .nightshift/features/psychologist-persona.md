---
status: exploring
---

# Psychologist persona

An in-character therapist who treats Harry Du Bois as their patient and comments on changes in his psychological well-being over the playthrough. The persona plays it straight as a clinician, with the game's tragicomic tone available, and speaks only from observed state under the standing spoiler discipline.

Captured 2026-08-15 from a user idea; delivery modes and evidence groups were confirmed in the capture conversation, the rest is provisional.

## Delivery modes

Three modes, confirmed at capture time as complementary rather than competing:

- **Woven-in observations.** Short clinical asides inside ordinary guidance answers when the consumed diff shows a significant psychological change. Structurally this generalizes the existing thought-notice rule: a reaction to state deltas surfaced by the single consuming diff read, delivered as a response notice, never as a queued task.
- **End-of-play-session psych report.** A fuller written assessment when a play session ends. Detecting "session over" is not something the current turn-scoped acquisition protocol can do on its own; this mode likely leans on the [companion execution runtime](companion-execution-runtime.md)'s session awareness and proactive notice delivery.
- **On-demand report.** A command (working name: `health`) that produces the full psych report whenever the player asks, independent of any session boundary. This is the cheapest mode to ship first because it needs only current state plus whatever history is already recoverable from saves.

## Evidence groups

All three groups confirmed in scope:

- **Vitals and morale.** Health and morale values and their deltas across saves, plus substance use inferred from consumable consumption.
- **Thoughts and build.** Internalized thoughts, skill point allocation, and copotype-style behavioral drift as expressions of Harry's self-concept.
- **Choice patterns.** Trends read from variables and reputation axes over time: self-destructive versus stabilizing trajectories, political and interpersonal leanings.

The persona diagnoses from evidence, not foreknowledge: it may characterize the trajectory the data shows, never predict or reveal upcoming content, tasks, or outcomes. Where the game itself is ambiguous, the clinician hedges in character instead of guessing.

## Family relationships

- The [adaptive guidance knowledge](adaptive-guidance-knowledge.md) evidence core is the natural home for persisted psychological-trajectory claims (morale trend lines, substance-use incidents, thought timeline). A trajectory needs history, and today's digest is a snapshot; whether the persona gets its own persisted timeline or piggybacks on the evidence core is an open question below.
- The [companion execution runtime](companion-execution-runtime.md) owns diff consumption and proactive delivery; woven-in observations and end-of-session reports would ride its state-event and notice machinery.
- The [TUI companion app](tui-companion-app.md) would present the `health` command and render reports; per [Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md) it invokes domain commands without owning their state.

## Open design questions

- Significance threshold: which deltas warrant a woven-in aside (morale swing size, any substance use, each internalized thought?) versus silence. An over-chatty clinician becomes noise; define the trigger set explicitly.
- History source: derive trajectories on demand from retained saves and the research cache, or persist a dedicated psych timeline as evidence-core claims with provenance and freshness like any other claim.
- The session-end signal is settled: the runtime emits a durable session-end event on game process exit or explicit user sign-off, and the persona queues its end-of-session report on any-cause end. See the [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle).
- Voice coexistence: how the in-character clinician voice sits inside answers otherwise written in the companion's normal analytic voice; a labeled aside block versus a full register switch.
- Report shape: structure of the full psych report (presenting concerns, observed changes since last report, prognosis) and how much game-mechanical detail it cites versus keeps in clinical register.
- Spoiler review: confirm every report section is derivable from observed state alone; the clinician must never diagnose from content the player has not seen.
