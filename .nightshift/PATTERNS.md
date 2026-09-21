# Patterns

Cross-cutting design patterns that apply across multiple features or feature families. Each entry points at a standalone file under `.nightshift/patterns/<slug>.md` with the full treatment.

This file is **one of four repo-local indexes** agents consult on demand when relevant (alongside `QUICK_WINS.md`, `FEATURES.md`, `BUGS.md`).

A pattern graduates here when the same structure would otherwise be re-described in two or more feature files. Lifting it into a shared home lets features link at the pattern rather than duplicating it, and makes design decisions about the pattern uniform across its members.

**Adding a pattern (or its breakout file) is not grammar-checked:** `/nightshift:ready` does not parse PATTERNS.md (it is a pattern registry, not a work backlog). When you add a pattern, verify its breakout-file link targets a real file under `.nightshift/patterns/` and run `/nightshift:ready` afterward as a whole-session sanity pass, so a stray malformed entry in the three work indexes is caught before it ships.

Backlog prose is one paragraph or one bullet per physical line, never hard-wrapped at a column: a search hit then shows the whole entry, the parsers anchor on whole lines, and an edit shows as one changed line instead of a reflowed block. `/nightshift:ready` reports a hard-wrapped file as a notice and `/nightshift:init-backlog` unwraps it.

## Current patterns

### [Runtime work, projection, and persistence boundaries](patterns/runtime-work-projection-persistence-boundaries.md)

Assign one owner to diff consumption, runtime execution, domain transitions, spoiler projection, and presentation. Defines durable state-event handoff, response notices versus hidden and deferred work, replay and acknowledgement, playthrough scope, and fail-closed projection for the runtime, TUI, and adaptive guidance feature family.
