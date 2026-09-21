# Evidence adoption: verification artifacts accepted without freshness/provenance binding

Found by the final crash review (2026-08-11), claimed CONFIRMED.

## Symptom

A reset checkpoint re-adopts stale `section-11-results.json` bytes as `pass`. `RecordVerification` records `result='pass'` on artifact content that was never validated against a fresh passing verification run.

## Mechanism

- `Invoke-StateExtractionV2Cutover.ps1` `BeginVerification` creates the evidence directory but never requires it empty or fresh.
- `RecordVerificationArtifact` records only a self-generated SHA-256; it does not validate the artifact content against a passing run.
- The section-11 harness refuses to regenerate over an existing `section-11-results.json` (`.tmp/Invoke-StateExtractionV2Section11.ps1`), so the only forward path after a checkpoint reset is adoption of whatever bytes exist.

This is the only channel found that can bless evidence without a fresh passing verification pass. Fail-closed with respect to fabrication of individual selector events, but the aggregate evidence claim can be satisfied by stale data.

## Fix

Either (a) `BeginVerification` requires the evidence root empty/fresh, or (b) `RecordVerificationArtifact` binds artifact content to its producing run (e.g. the section-11 harness's assertion-registry hash and spec fingerprint are part of the artifact, and re-adoption requires those to match a fresh run).

## Status

Tracked 2026-08-11 by user disposition (do not implement mid-handover; cutover is already NOT READY). Requires: none.