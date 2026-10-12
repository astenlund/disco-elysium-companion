---
status: exploring
---

# Coordinator retention checkpoints

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Fresh Fable whole-spec review 840fb9e8 and independent Astra skeptic 9f5083f8 confirmed a minor, required:false cadence mismatch. The shared persistence pattern says retention runs after a successful write that changes family cardinality or terminal eligibility and once during startup. The runtime design names phase-H startup retention and on-demand capacity passes; current code runs maintenance at startup or capacity failure, but successful acknowledgement changes cursor/stamps/eligibility and only observes status. An exact-function fixture selected an age-expired event for compaction while low counts admitted ordinary work. This is delayed compaction and capacity-status re-evaluation, not data loss; adding per-write passes could increase native helper cost on the already slow startup/turn path. No accepted performance measurement or coordinator-specific specialization resolves the tradeoff yet.

## Direction to investigate

Triage a bounded coordinator retention checkpoint rule: either implement coalesced safe post-transition retention with a deciding post-ack fixture and measured cost, or explicitly approve and document a coordinator specialization with its maximum lag/retry path. Preserve 180-day/8,192 constants and all protected-evidence rules; no timer or implicit abandon.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
