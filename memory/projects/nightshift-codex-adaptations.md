# Nightshift adaptations for Codex

Use these adaptations whenever Nightshift instructions are executed in Codex for
this companion. The Nightshift source tracks a future native cross-host migration;
until it lands, translate the current Claude-oriented instructions explicitly.

Host gate: apply this file only when the current host is Codex. Claude Code must
use Nightshift's native Claude tools, environment, hooks, and model pins instead.

## Stable project layout

- Keep `.claude/` as Nightshift's shared backlog-data namespace. Do not rename it.
- `AGENTS.md` is the canonical project instruction file.
- `CLAUDE.md` is only the `@AGENTS.md` bridge for Claude Code.
- Maintain both host hooks when their shared directive changes:
  `.claude/settings.json` for Claude Code and `.codex/hooks.json` for Codex.
- Do not run `nightshift:init-backlog` unadapted. It targets `CLAUDE.md` and only
  the Claude Code hook. Apply its intended merge to `AGENTS.md` and both hook files.

## Tool translation

| Nightshift instruction | Codex execution |
|---|---|
| Workflow tool | Run the documented manual reviewer and skeptic engine. |
| Agent tool | Use Codex collaboration agents. |
| TaskCreate queue | Use `update_plan` for the visible flat queue and the prescribed `.tmp` scratch files for durable follow-ups. |
| AskUserQuestion | Use the available user-input tool when surfaced; otherwise ask plainly in chat. |
| `${CLAUDE_PLUGIN_ROOT}` | Resolve the current installed skill path surfaced by Codex. Never assume the environment variable exists. |

- Codex has four total collaboration slots including the coordinator. Batch manual
  reviewer and skeptic fan-out within that limit without dropping prescribed agents.
- Fresh-agent prompts must carry the applicable project rules as required by the
  global `AGENTS.md` subagent convention.
- Edit Nightshift only in `C:/Git/nightshift`, never in an installed plugin cache.

## Model translation

| Claude pin | Codex pin |
|---|---|
| `opus` | `gpt-5.6-sol` |
| `sonnet` | `gpt-5.6-terra` |

Preserve the requested reasoning effort when translating a model pin. Record the
substitution in review state and reports rather than claiming the models are identical.

## Instruction and documentation routing

- When revise instructions say to read, inline, or edit project `CLAUDE.md`, use
  project `AGENTS.md` instead.
- Route project lore and durable constraints to `AGENTS.md`.
- Route Nightshift workflow changes to the Nightshift clone with the required review,
  commit, version, and push rules.
- Adapt `revise-docs` checks that name `CLAUDE.md` to the canonical `AGENTS.md`.
- The companion intentionally has no Git repository. Follow its explicit no-Git
  checkpoints, test gates, `no-git` provenance text, and `.tmp/preedit-*.bak`
  rollback protocol. Never invent commits or SHAs.
