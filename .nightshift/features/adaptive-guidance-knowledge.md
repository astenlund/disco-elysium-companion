---
status: exploring
---

# Adaptive guidance knowledge

Build a game-specific knowledge layer that lets the companion give fast, spoiler-safe guidance about tasks, checks, timing, prerequisites, missable side content, and progression boundaries. The companion may know more than the player, but its disclosure layer must reveal only information appropriate to the player's observed state and question.

This file is the umbrella for a guidance-knowledge feature family. Its candidate slices may graduate independently once the evidence lifecycle and runtime event contracts are firm.

## Ownership boundary

Adaptive guidance owns game-domain claims, evidence policy, spoiler projection, research selection and priority, and the state transitions of hidden and user-requested research records. The [companion execution runtime](companion-execution-runtime.md) owns worker attempts, retry, cancellation, offline handling, and shutdown. The [TUI companion app](tui-companion-app.md) renders projected notices and deferred records and invokes domain commands without writing their state directly.

The shared lifecycle is defined by [Runtime work, projection, and persistence boundaries](../patterns/runtime-work-projection-persistence-boundaries.md).

## Candidate slices

These are provisional design seams while the feature remains Exploring. They are not the formal `**Slices:**` block consumed by `/nightshift:ready`.

### Evidence core and safe query

Persist typed claims per playthrough with provenance, confidence, disputes, timestamps, schema and adapter versions, source freshness, and invalidation. Link derived results to state generations and expose only a fail-closed disclosure projection to player-facing consumers. Define the disclosure intent classification consumed by focus promotion as exactly one of `criticalPath`, `meaningfulSideContent`, or `busywork`. A classification records and is consumable only with the governing disclosure-policy, comparator, and adapter versions, the evidence generation, every candidate entry version, and source store incarnation. Recency-only store-sequence drift may be revalidated under the store lock; any policy, comparator, adapter, evidence-generation, entry-version, incarnation, content, or eligibility change is stale or superseded and must not be consumed. The disclosure producer owns one stored player-safe label for each ad hoc activation; promotion revalidates that label at promotion time and never regenerates or exposes raw activation text. Only a definitive one-of-three result is consumable; missing, failed, conflicting, or uncertain classification is non-definitive and fail-closed, leaving entries unresolved and retryable. Provide an immediate foreground query path and a migration from the temporary playthrough research cache. Ad hoc activation requires this Evidence core specifically for activation-time safe-label production; the conversational agent continues to own initial intent-summary approval, and promotion-only classification remains gated to the later promotion slice.

Disclosure producer handoff is read-only and binding-bearing. Activation uses the shared [`TrustedActivationApprovalV1`](session-focus.md#commands-and-selection) handoff: it returns only the validated safe label and intent summary plus their activation-time policy, comparator, disclosure, adapter, evidence-generation, store-incarnation, runtime, adapter-binding, principal, and play-session bindings. Promotion-only classification remains a separate producer snapshot and is not part of activation approval. Focus copies the accepted activation snapshot atomically with its activation transition and mints the activation identity only after acceptance. A missing, stale, foreign, or rejected snapshot causes no focus mutation or identity allocation and remains retryable or revalidated; this handoff implies no distributed cross-store transaction.

For activation, `TrustedActivationApprovalV1` carries the approved safe label and intent summary plus the activation-time disclosure and capability bindings; promotion-only classification remains a separate producer snapshot and is not part of the activation approval. The approval includes the current adapter-binding epoch and raw-text capability state, and its acceptance or rejection is governed by the Focus contract.

This is the likely adaptive-guidance MVP and needs only the existing state contract, not the TUI or background workers.

### Horizon reconstruction

Build a bounded current-horizon model from the latest save and a small evidence pack when the companion joins a playthrough late. Keep the first adapter specific until a second adapter proves which stage signals and namespaces are genuinely generic.

### Check loadout resolver

Resolve required tools, check-specific dress codes and modifiers, and the best owned clothing combination. Recompute affected results when inventory, checks, skills, equipment, thoughts, or modifier evidence changes.

### Thought-discovery notices

Turn newly known thoughts into spoiler-projected response notices with build-aware recommendations and hidden backfill for incomplete evidence. Notices remain distinct from user-visible deferred tasks.

### Hidden enrichment policy

Create and prioritize automatic research from warm-start and state-change signals. The domain assigns purpose, priority, visibility, and evidence requirements while the runtime work broker performs attempts and retries.

### Deferred research workflow

Own durable queued, researching, ready, and consumed transitions for work the user explicitly asks to receive later. Store projected results for presentation clients; the TUI inbox depends on this workflow, not the reverse.

### Adaptive interest profile

Apply explainable, resettable priority nudges learned from repeated questions. This is a later continuation and never lowers evidence or spoiler standards.

A declared [session focus](session-focus.md) enters the same priority model as an explicitly-sourced nudge that outranks learned nudges for the session, and while active it also reorders which recommendations lead in guidance dialogs, a reach the learned profile does not have; balanced means no override and leaves the learned profile alone in charge. Learned observations carry a session-phase signal so recall weights by phase: what the player wants early in a session differs from two hours in, and the previous session's tail must not over-weight the next session's start.

### Generic research-adapter contract

Define cross-game stage signals, source discovery, graph namespaces, and adapter-owned projection metadata after the first adapter supplies implementation evidence. This blocks multi-game adaptive guidance, not the first useful version.

## Product behavior

- On first launch, assume the companion may be joining a playthrough late. Reconstruct the player's current horizon from the latest save rather than relying on companion history.
- Give immediate, confidence-calibrated answers from current state and cached knowledge. When an unfamiliar subject matters to the answer, perform a small foreground lookup instead of blocking on exhaustive research.
- When guidance leads to a white or red check, calculate the best loadout from currently owned clothing and held items. Required tools and check-specific dress codes take precedence over raw skill maximization. Show exact swaps and the net effect, never recommend unowned gear, and disclose consumable costs before use.
- Every addition at `extra.thoughts.known` creates a player-visible thought alert in the response that consumes the delta, before ordinary guidance. It is not a TUI inbox task. The alert recommends internalize now, hold for later, or not a current priority using only the thought's disclosed mechanics and current build state.
- Run deeper enrichment silently in the background. Newly acquired tasks, subtasks, and relevant checks refresh the knowledge graph without creating user-visible work items.
- Only work explicitly requested by the user appears in the TUI task inbox. Requests may ask for deeper research, an option comparison, or a later report backed by stronger evidence.
- A visible task moves through queued, researching, ready, and consumed states. The TUI provides an indicator for ready results and a keybinding that jumps to the next ready item so the user can consume it when convenient.

## Warm-start stage reconstruction

First launch builds a stage fingerprint from completed and active objectives, acquired subtasks, day and time, location, inventory, thoughts, checks, recent state when available, and selected adapter-owned game signals. Progress is represented as reached milestones and open branches, not as one linear chapter, because the player may have taken a nonlinear route.

The initial research pass uses a small source pack with distinct roles:

- Broad walkthroughs establish progression structure and major boundaries.
- Task references establish prerequisites, delayed follow-ups, alternate paths, and availability conditions.
- Completionist and missables guides identify side-content risks.
- Forums resolve ambiguous mechanics, source conflicts, and known UI or task state bugs.

The pass stops when it has reasonable coverage of the player's current horizon: active tasks, known white checks, waiting tasks, plausible expiry or point-of-no-return risks, nearby meaningful side content, and prerequisites relevant to those items. It does not attempt to understand the entire game before the companion becomes useful.

## Knowledge and evidence model

Research stores atomic claims rather than copied guide prose. Each claim records its subject, relationship or property, applicability conditions, provenance, confidence, research timestamp, and spoiler classification. Sources may include internal model knowledge, game assets, wikis, walkthroughs, guides, and forums.

Check claims also record the tested skill, color, base difficulty, retry state, required tools, situational modifiers, dress-code conditions, and item bonuses or penalties. The loadout resolver combines those claims with current inventory and equipped state. Live save modifiers outrank static metadata when they conflict; unsupported bonuses remain unknown rather than being guessed.

Thought-discovery claims are created from each `extra.thoughts.known` addition. They record research duration, temporary and permanent modifiers, known thought-slot or skill-point cost, current-build assessment, recommendation category, confidence, and reconsideration triggers. The player projection names only the thought already discovered and its mechanics. Unknown effects produce a provisional alert and hidden enrichment, never a speculative recommendation or a visible inbox item.

Loadouts refresh from two mandatory triggers. A newly acquired item is matched against every known active, retryable, and seen check whose skill, tool condition, dress code, penalty, or check-specific modifier it could affect. A newly discovered check is evaluated against the entire owned inventory and current equipped state. Changed resolutions are persisted atomically with the triggering state generation. Incomplete modifier knowledge produces a provisional loadout and hidden enrichment; the last evidenced loadout remains available with its stale or provisional status.

Conflicting claims remain disputed until corroborated. Weak evidence produces an explicitly uncertain answer and can trigger background backfill; it never becomes a confident urgency claim by default. Subagents may gather and reconcile evidence when a topic is unfamiliar or misspeaking would be costly.

The internal graph may contain undiscovered tasks and future relationships. A separate disclosure projection combines the graph with the current save and the user's question. It must not reveal the existence, name, outcome, prerequisite, or timing of unseen content unless the user explicitly requests broader spoilers. Raw activation phrases are private durable comparator input only, excluded from projections, events, audits, logs, errors, and presentation. Retain a phrase while its owning entry remains active, unresolved, eligible, requeueable, or otherwise referenceable. Delete it only in the same accepted atomic transition that makes the entry non-referenceable, including expiry, matched-entry removal, pruning, or repair omission or terminalization; terminal job or attempt outcomes alone do not authorize deletion. Repair retaining an active or eligible entry carries forward its exact validated phrase; missing or changed phrase either rejects the repair with the prior store intact or terminalizes the entry and deletes the phrase atomically. Failed or stale repair preserves it. Phrases cross a provider boundary only under an explicit approved raw-text data-handling capability and policy; otherwise work remains blocked or retryable with no disclosure.

## Adaptive research priorities

Questions update a small, explainable interest profile for the playthrough. Repeated interest in areas such as side-content preservation, expiry risk, white checks, mechanics, build choices, or completionism raises the priority of those fields during later enrichment. A single question nudges priorities; repeated patterns shape them more strongly.

The profile controls research order only. It cannot lower evidence standards or weaken spoiler filtering, and it is resettable. A declared [session focus](session-focus.md) shares the profile's priority model and additionally reorders recommendation ranking while active; it is bound by the same evidence and spoiler limits.

`runtimeSessionId` is provenance and activation-uniqueness metadata only. Retained eligible entries and jobs may compare across runtime restarts within the same adapter and principal store incarnation. Promotion diversity uses authoritative `playSessionId` only; a runtime restart never creates a new comparison job or treats a new runtime session as a distinct play session.

Adaptive promotion candidates use a durable identity over adapter and principal, store incarnation, sorted entry IDs and versions, eligibility and content, and disclosure and comparator bindings. Candidate selection skips an already-terminal non-promotable identity; recency-only drift revalidates it, while incarnation, version, eligibility, content, or binding drift creates a new identity. `nonPromotableUnsafeLabel` and `nonPromotableUnsafeSummary` are durable terminal attempt and job outcomes with one `storeGeneration` advance, no automatic retry, candidate-identity suppression, activation-source attribution, and no unsafe text exposure. The unsafe-summary visible-fault branch changes no catalog, active selection, promotion, or non-fault projection state, terminalizes the job, leaves entries unresolved, disables automatic retry, and sets or replaces activation-sourced `configurationFault` with one revision and `focus.fault` event only when changed; an identical fault is a no-op, and incumbent unrelated faults remain visible. Missing, uncertain, unavailable, or failed disclosure stays retryable. A safe-fallback handoff is admitted; activation-sourced configuration fault wins the visible slot when comparator also fails, while comparator failure remains private retryable evidence. A same-activation label retry replaces fallback and clears only its configuration fault, then atomically leaves `semanticComparisonFault` if comparator failure remains or clears the slot otherwise; comparator success clears only the same-source semantic fault. Pair comparison is all-or-none: one-direction failure persists neither evidence nor recency and keeps the pair retryable. Promotion reconciles overdue active-focus expiry before candidate validation or conversion; committed expiry leaves Balanced and `activeSelectionConverted: false`, while failed reset leaves promotion retryable without partial mutation. Pending promotion supersession keys only authoritative catalog removal or repair omitting the canonical ID; picker-only omission or projection-capacity failure leaves handoff pending and unacknowledged for retry, while rename or current membership preserves identity. The 180-day entry clock governs private comparator input, jobs, and promotion eligibility but does not reset an otherwise-current eight-hour focus. When both clocks are observed, active-focus expiry or reset is reconciled first, then history terminalization or pruning.

## TUI relationship

This feature supplies the research scheduler, graph, disclosure projection, and durable deferred-result records. The [TUI companion app](tui-companion-app.md) owns presentation of the user-visible task inbox, status indicators, navigation keybindings, and consume commands. The adaptive domain service performs and persists the consumed transition. Hidden warm-start and save-triggered enrichment does not appear as inbox clutter.

## Open design questions

- Define the adapter contract for stage signals, source discovery, and graph namespaces across games.
- Define the claim schema, confidence policy, conflict-resolution rules, and cache invalidation lifecycle.
- Define the bounded foreground-search policy and the point at which a request becomes a visible deferred task.
- Define the domain scheduling contract with the runtime work broker, including priority, visibility, evidence requirements, idempotency, and source-rate policy.
- Define the disclosure policy for ordinary spoiler-safe play and explicit user-requested spoiler levels.
- Decide how the interest profile is inspected, reset, and carried across multiple playthroughs of the same game.
