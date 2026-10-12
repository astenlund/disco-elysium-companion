---
status: exploring
---

# Long-lived runtime history

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Fresh Fable review cf8e8415 and independent Astra dialogue a2f94de0 identified a bounded MVP limit. The runtime keeps compact event evidence without ordinary pruning, caps retained repair handoffs at 8,192, and the current header repair plans handoffs for all readable compact and live event identities. A bounded pure probe with 8,193 compact and two live descriptions reproduced a pre-witness handoff-capacity refusal; it did not prove permanent unrepairability or execute release/re-entry. The authorized correction is being implemented to refuse ordinary work earlier when its next recovery reserve cannot fit, while preserving evidence and separate release. The governing design explicitly does not guarantee indefinite ordinary play or restore an already oversized journal. No alternative long-lived preservation architecture has been agreed or implemented.

## Direction to investigate

Triage a separate design for continuing a long-lived runtime beyond the fixed handoff reserve while preserving delivered compact evidence and safe repair authority. Compare bounded archival or other preservation approaches against retention, journal identity, quarantine, replay and crash recovery before selecting one; do not silently prune evidence or raise production limits as an incidental MVP fix.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
