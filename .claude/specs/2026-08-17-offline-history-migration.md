# Repository Relocation Documentation Corrections

## Decision

The repository relocation is complete. On 2026-08-18, the user declined migration
of Claude and Codex history and chose documentation-only cleanup. The historical
filename is retained to avoid an unrelated file move.

## Operating context

- **Deployment and criticality:** local, tracked documentation with no runtime
  component or external outage surface. Uplift not fired.
- **Audience:** one repository owner and their coding agents, with an
  owner-controlled trust boundary, no commercial promise, and no external userbase.
  Judgment: `personal use` is the closest audience category.
- **Failure and sensitivity:** an error can mislead a later maintainer but cannot
  mutate host history, game state, or sensitive data. Uplift not fired.
- **Concurrency and compatibility:** ordinary single-worktree text edits with no
  concurrent writer or interface contract. Uplift not fired.
- **Reversibility and recovery:** Git-tracked prose is cheaply inspectable and
  reversible, with no external recovery operation. Uplift not fired.
- **Expected lifetime:** this is a one-time correction with no continuing mechanism;
  its durable documentation value does not create an operational lifecycle. Judgment:
  the lifetime uplift does not fire.

Derivation: `personal use` gives baseline `low`; zero uplifts leave the tier `low`.
Validation, recovery, compatibility, observability, and proof effort are all `low`
above the correctness floor.

## Scope

Implementation changes have two correction targets, while this durable decision
record is the third tracked documentation file included in the implementation commit.

### `.claude/QUICK_WINS_HISTORY.md`

Correct the repository-relocation entry shipped on 2026-08-17. Preserve its valid
acquisition, configuration, and reopen facts, but record the actual sequence:

- The repository was copied, not moved in place.
- Source and destination manifests of relative paths, byte lengths, and SHA-256
  hashes matched before the new root became authoritative.
- Source contents were cleared after verification. The temporary shell held the
  empty old root until it exited; the old root is now absent.
- Pre-relocation Claude prompt-history project fields and Codex thread
  working-directory fields intentionally retain the old identity. New sessions and
  already-moved host configuration use `C:\Git\disco-elysium-companion`.

Remove the existing claims that the whole directory moved in place and that host
history moved to the new identity.

### `.claude/specs/state-extraction.md`

Make only these four path corrections:

1. Remove the `except companion\` exception from the Disco Elysium directory's
   read-only rule.
2. Replace `companion\.tmp\` with
   `C:\Git\disco-elysium-companion\.tmp\` in the save-copy rule.
3. Replace `companion\core\` with `core\` in the game-agnostic core rule.
4. Replace `outside companion\` with `outside the repository root` in the
   repository boundary rule.

Preserve all surrounding content.

## Out of scope

Do not migrate, rewrite, or otherwise touch Claude or Codex history, session
archives, thread state, rollout files, game state, SaveGames, host configuration,
or the absent old repository root. Do not create migration scripts, tests,
backups, receipts, state files, recovery paths, or ignore rules.

## Acceptance criteria

- The corrected quick-win entry states the verified copy and cutover sequence and
  the intentional decision to leave pre-relocation host-history identities unchanged.
- The state-extraction diff applies all four listed path corrections and contains
  no other changes.
- Implementation changes are limited to these tracked documentation paths:
  `.claude/QUICK_WINS_HISTORY.md`, `.claude/specs/state-extraction.md`, and
  `.claude/specs/2026-08-17-offline-history-migration.md`.
- `git diff --check` reports no whitespace errors.

## Hardening

- revise-spec graduated 2026-08-18 11:15 at b5dd551, scope: whole file, content: e688a67c
