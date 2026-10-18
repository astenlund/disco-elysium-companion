---
status: exploring
---

# Reduce PowerShell runtime dependency

The user raised this as a future slice on 2026-10-18 if the current compiled Go startup path is adopted. This draft does not alter the 30-second startup or 180-second recovery acceptance gates.

Inventory each PowerShell launch in direct chat, including bootstrap, admission, supervision, core operations, source validation, publication and maintenance. Decide which behavior should move to compiled Go or another maintained component, and which scripts should remain. Preserve physical path identity, process ownership, bounded control and output, durable postconditions, warning disclosure, recovery and verified stop when replacing a boundary. Measure dependency count and startup or interaction cost from the current implementation before choosing a migration order. If the Go path is not adopted, revisit whether dependency reduction still justifies a separate slice.
