# Patterns

Cross-cutting design patterns that apply across multiple features or
feature families. Each entry points at a standalone file under
`.claude/patterns/<slug>.md` with the full treatment.

This file is **one of four repo-local indexes** Claude reads on every
session start (alongside `QUICK_WINS.md`, `FEATURES.md`, `BUGS.md`).

A pattern graduates here when the same structure would otherwise be
re-described in two or more feature files. Lifting it into a shared home
lets features link at the pattern rather than duplicating it, and makes
design decisions about the pattern uniform across its members.

**Adding a pattern (or its breakout file) is not grammar-checked:**
`/nightshift:ready` does not parse PATTERNS.md (it is a pattern registry,
not a work backlog). When you add a pattern, verify its breakout-file
link targets a real file under `.claude/patterns/` and run
`/nightshift:ready` afterward as a whole-session sanity pass, so a stray
malformed entry in the three work indexes is caught before it ships.

## Current patterns

### [Runtime work, projection, and persistence boundaries](patterns/runtime-work-projection-persistence-boundaries.md)

Assign one owner to diff consumption, runtime execution, domain transitions,
spoiler projection, and presentation. Defines durable state-event handoff,
response notices versus hidden and deferred work, replay and acknowledgement,
playthrough scope, and fail-closed projection for the runtime, TUI, and adaptive
guidance feature family.
