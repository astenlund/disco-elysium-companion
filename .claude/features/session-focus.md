---
status: exploring
---

# Session focus

A session-scoped dial declaring what kind of progress the player wants right
now. Exactly one focus is active at a time; the default is **balanced**, which
means no declared override: the learned interest profile alone steers
priorities. A non-balanced focus is a statement of session intent ("this
session: white checks") that the guidance machinery honors until it is changed
or the session ends.

## Ownership boundary

Focus state is domain state owned by
[adaptive guidance](adaptive-guidance-knowledge.md): it changes guidance
behavior and must survive a TUI restart. The
[TUI companion app](tui-companion-app.md) renders the control (a status-bar
chip plus a pick or cycle keybinding) and invokes a command; the
[companion execution runtime](companion-execution-runtime.md) carries the
command and supplies the session lifecycle boundary. The shared contract is
[Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Mechanics

- A declared focus is a strong, explicitly-sourced priority nudge in the
  interest-profile machinery of adaptive guidance. One priority model, two
  input sources (learned versus declared); the declared source wins for the
  session. The learned profile's reach stays research order only; the declared
  source additionally reorders which recommendations lead while it is active.
  Balanced is the absence of an override, not another competing weight, so the
  empty branch is the pre-feature status quo.
- Reach: a focus reorders which recommendations lead in guidance dialogs and
  steers hidden enrichment toward focus-relevant claims, so answers in the
  focus area are richer during the session. Briefs are deliberately out of
  reach: the landing and situation brief stays focus-independent, so
  re-orientation after time away never hides critical-path state. Widening
  reach into briefs is a possible later continuation, not part of this design.
- Hard boundary: focus steers priority only. It never weakens spoiler
  projection, evidence standards, or the critical path / meaningful side
  content / busywork classification itself; a side-quests session still labels
  busywork as busywork.
- The active focus is always inspectable, like the learned profile it
  overrides: the TUI chip names it, and under the near-term bridge the
  companion states it when a declared focus materially shapes an answer.
- Lifecycle: the focus reverts to balanced at session end or after a long gap;
  a TUI restart is not a session end (focus state survives it, per the
  ownership boundary). Mirrors the auto-revert rationale of the TUI's
  per-question model effort control: a sticky declared intent would silently
  tax the next session. The session-end signal itself is settled: the runtime
  emits it on game process exit or explicit user sign-off (see the
  [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle)),
  and a long gap remains an independent revert path.

## Session-phase-aware learning

What a player wants early in a session often differs from two hours in. The
learned interest profile must account for this within-session drift so that
balanced mode does not annoy: recall at session start should draw on what the
player historically wanted at session starts, not on the tail of the previous
session, otherwise late-session question patterns over-weight the opening of
the next one. Candidate shape: tag interest observations with a session-phase
signal (elapsed session time or question ordinal) and weight recall by the
current phase. The concrete model belongs to the adaptive interest profile
slice in [adaptive guidance](adaptive-guidance-knowledge.md); this draft only
fixes the requirement.

## Focus vocabulary

The vocabulary is adapter-owned data, like theming: a small generic core
(balanced as the selector's null entry rather than a vocabulary item, plus
story and side content, which line up with the critical path and meaningful
side content classes; no focus targets busywork) plus adapter-declared
focuses. Provisional Disco Elysium candidates: story, side quests, white
checks (retryable-check mop-up with loadout preparation), loot and money,
thoughts and build, exploration and lore. Labels must remain spoiler-safe
generic categories; a focus name never reveals unseen content.

## Near-term bridge

Before the TUI exists, the CLAUDE.md-driven companion can honor a declared
focus informally via the playthrough research cache (the player states the
session focus in chat and the cache records it), making the idea testable in
play before any code exists.

## Open design questions

- The session-end signal is settled: the runtime emits a durable session-end
  event on game process exit or explicit user sign-off, and the focus reverts
  to balanced on session end. See the
  [play-session lifecycle](../patterns/runtime-work-projection-persistence-boundaries.md#play-session-lifecycle).
- What gap length counts as "a long gap" for the auto-revert, and whether the
  player is told the focus reverted.
- Focus scope is settled with playthrough identity: a playthrough is the
  signed-in principal's save set for the adapter, so focus scope is per
  (adapter, principal identity). See the
  [playthrough identity](../patterns/runtime-work-projection-persistence-boundaries.md#playthrough-identity-settled)
  settlement; carrying state forward across a fresh run of the same game is the
  deferred multi-playthrough data question, distinct from identity.
