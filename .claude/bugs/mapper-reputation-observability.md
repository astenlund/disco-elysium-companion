# Reputation mapping is not fixture-observable (claim 11)

Found during Section 11 registry wiring (2026-08-11).

## Symptom

The mapper's reputation mapping is a hardcoded static property (`Build-Digest.ps1` `$reputationMap`). Section 11 claim 11 (Reputation mapping) requires fixtures that duplicate a vendor name, add a case variant, or use a misspelled mapping entry. Each would require editing the vendored `variables_reputation.json` or the mapper source, not a dump fixture. No passing selector can exist without a mapper/design change. The registry row `section11-11` therefore has no genuine selector.

## Fix options

(a) Restructure the reputation mapping so the claim's negative fixtures are drivable through a dump fixture, or (b) narrow the claim to the already-observable wrong-kind / missing-member rejection and mark the duplicate/case-variant clauses spec-deferred.

## Resolution (2026-08-12, option b)

Option (b) was chosen: section11-11 is now wired to a genuine selector `Test-Build-Digest.ps1#MapperReputationSemantics` that asserts the dump-observable clauses of claim 11 - a complete sentinel fixture over all ten mapped store variables asserting every one of the ten digest paths against the exact 6.3 source row (so a valid-but-wrong store name cannot pass), plus the wrong-kind store value rejection. The misspelled-mapping-entry, duplicate-vendor-name, and bad-initial-value clauses require a vendored-DB or mapper-source fixture seam that does not exist in the fixed mapper CLI and are spec-deferred; the selector comment and coverage manifest carry that boundary. The section-11 registry advances 60 -> 62/77 with this row plus section11-12 (thought-sorting, wired to the existing `MapperThoughtOrdering` selector).

## Status

Resolved 2026-08-12 via the documented option-b narrowing; the observable claim clauses are covered by a real selector and the remaining clauses are spec-deferred. Requires: none.
