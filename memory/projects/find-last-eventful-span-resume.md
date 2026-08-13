# Resume Find-LastEventfulSpan work

This is the durable resume map for the interrupted Nightshift run.

This memory is shared by Claude Code and Codex. The state and artifact instructions
apply to both hosts. Execution adapters and model substitutions apply only in the
host-specific branches below.

## Read order

1. `.tmp/HANDOVER.md`
2. `.tmp/revise-state.md`
3. `.tmp/revise-payload.md`
4. `.claude/plans/2026-08-08-find-last-eventful-span.md`
5. `.claude/specs/state-extraction.md`, section 7.4 and its deltas in sections
   3, 8, 10, and 11

For a specific ambiguity only, search the interrupted Claude transcript narrowly:

`C:/Users/asten/.claude/projects/C--Users-asten-AppData-LocalLow-ZAUM-Studio-Disco-Elysium/ec082e3f-6344-4c8c-a051-6738384c900b.jsonl`

The useful tail begins around line 4274. Do not load the whole transcript by default.

## Authoritative state

- The spec graduated after 11 iterations with 57 distinct roots fixed.
- Its current stamp is `3ca627a3`.
- The implementation plan is mid-revise-plan.
- Iterations 1 through 10 completed with 42 distinct roots fixed.
- Only Requirements clarity remains active. All other plan dimensions graduated.
- Iteration 11 was launched as Claude Workflow run `wf_eb588801-ed3`, then terminated
  or orphaned during the pause. It produced no recoverable result. Treat it as absent.
- The user-set review ceiling is 12 iterations. This overrides the older default-cap
  text in `revise-state.md`.
- Implementation has not started.

Iteration 10 made two final plan corrections:

- Defined the exact scope of the aggregated no-state-directory fixture check.
- Reclassified ACE apply and removal checks as loud fixture guards rather than
  assertions, reducing Step 6 from 6 assertions to 4.

The resulting prescribed totals are authoritative:

- `Test-DigestDiff.ps1`: exactly 71 assertions.
- `Test-FindLastEventfulSpan.ps1`: exactly 65 assertions.
- Find-span fixture decomposition: `27 + 11 + 7 + 4 + 12 + 4`.

## Resume the plan review

Before relaunching reviewers, reconcile the plan's stale canonical-file references:

- Task 9 currently says to edit and grep `companion/CLAUDE.md`.
- Change those instructions to target canonical `companion/AGENTS.md` while leaving
  `CLAUDE.md` as the one-line bridge.
- This reconciliation is inside the active Requirements clarity scope.

Then regenerate or verify `.tmp/revise-payload.md` and run iteration 11 using the
current host's engine:

1. In Claude Code, relaunch the native Nightshift Workflow engine with the original
   `opus` pin and the payload's single Requirements clarity dimension.
2. In Codex, use the manual Nightshift engine with `gpt-5.6-sol` in place of
   `opus`, preserving high effort, and launch two fresh Requirements clarity
   reviewers.
3. For every non-LGTM finding, launch the Nightshift-prescribed fresh skeptic and
   require concrete verification.
4. Apply only confirmed findings, record refuted findings as acknowledgements, and
   regenerate the payload at the iteration boundary.
5. One clean pair graduates Requirements clarity and the plan.
6. If confirmed fixes land, run iteration 12. Stop at the ceiling even if it does
   not graduate, and report the cap outcome accurately.

## Post-review work still owed

After plan graduation or cap handling:

- Append the plan hardening stamp using the existing Nightshift recipe and the
  project's `no-git` provenance convention.
- Run Spec Reconciliation. One known candidate requires user approval: generalize
  section 11's found-true fixture away from wording that names a rotated-off real
  Day 3 save and instead require a differing-content pair.
- Route follow-ups and write the dimension and authoring retrospectives.
- Delete revise scratch only after all post-loop steps complete.
- Execute the plan task by task using its test gates and pre-edit backups.
- Run revise-code with native `sonnet` in Claude Code. In Codex, use
  `gpt-5.6-terra` in place of `sonnet`.
- Complete the live wide-bounds probe, present-tense documentation reconciliation,
  final `no-git` spec restamp, backup deletion, and morning report.

SaveGames remains strictly read-only throughout. All copies and scratch work stay
under `companion/.tmp` as prescribed by the project and plan.
