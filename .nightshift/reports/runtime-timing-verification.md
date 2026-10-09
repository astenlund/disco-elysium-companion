# Runtime timing verification

The [coordinator budget model](../features/companion-execution-runtime.md#state-acceptance-and-context-safety) requires runtime-owned phase measurements before acceptance. Core acquisition alone does not establish interaction latency or settlement headroom. The [core acquisition observation](../features/state-extraction.md#11-verification-for-the-implementation-plan-to-expand) remains separate.

The current complete interaction and acknowledged-binding restart check is still outstanding. Its scenario uses the actual coordinator, core, native helpers and SessionHost with a declared fake ProviderSession. That can measure runtime-owned work and verify delivery bookkeeping; it cannot measure model response latency or prove live guidance behavior. The test retains its original assertions and timeout. A timeout or missing final process result is an incomplete check, even if an instrumented body later returns.

## Bounded helper observation

On 2026-10-09 local time (raw UTC interval 2026-10-08T22:00:52.975Z through 22:01:08.994Z), a private path-admission benchmark on Windows x64, Node v22.23.2 and PowerShell 7.6.6 ran three interleaved samples per variant. One variant used the production `Get-PathAdmission.ps1`, which compiles `NativeFiles.cs`; the other loaded an assembly compiled from that same source. Both retained the same ProcessSupervisor and its ownership checks. The target was one ordinary synthetic file under repository `.tmp`.

| Variant | Samples, milliseconds | Median, milliseconds |
|---|---|---:|
| Compile source in the helper | 2299.6648, 2320.3798, 2274.0500 | 2299.6648 |
| Load the precompiled assembly | 1974.7725, 1895.1809, 1957.7411 | 1957.7411 |

All six admission replies were byte-identical. The target and production helper stayed unchanged, and the metadata job was quiescent. Compilation of the experimental assembly took 2657.7335 milliseconds once, separately from the samples. This demonstrates a remaining per-call cost under the existing process supervision after precompiling one helper; it does not attribute that remaining cost to one subsystem or estimate a whole-turn saving.

The local diagnostic source is `.tmp/nightshift/probe-helper-overhead.ts`; its result is `.tmp/nightshift/probe-helper-overhead-7e11839e-8206-44c3-874d-20cf33a6ecd9/result.json`. The record includes source, helper and assembly hashes. These ignored local artifacts are measurement evidence, not shipped runtime machinery or replay authority. No production assembly cache, persistent helper host, deadline change or skipped acquisition was selected.

## Interpretation and remaining verification

Earlier development timing records under `.tmp/nightshift/backend-impl/timing-1791465843470/` contain expensive helper/store operations and one interaction that ended fresh. They do not record an interaction gate expiry. Store, core-check and drain intervals overlap, so adding their totals would overstate elapsed time. Startup `settlementPending` notices from unavailable/recovering safety are distinct from deadline expiry. Those records do not establish current end-to-end acceptance.

The deciding record must identify actual new and pending records, retained history and payload sizes; distinguish the acquisition from the shared post-publish settlement gate; and report preview, preparation, sent-mark, actual-send-copy, acknowledgement and restart outcomes separately. Helper counts explain those phases, while non-overlapping wall time decides their total. For each exercised workload, separately count expiry before another checked arm, expiry after arm before child start, truncated children, and interrupted result or completion publication; record the resulting safety check, correction and provider-session eligibility. Mark unexercised branches unmeasured, not zero. At least zero-new-record and one-new-record steady-state cases must be identified; exercised backlog, recovery and history-size cases and remaining gaps must be listed. The 120-second gate stays fixed while this work is incomplete, and any unmet target remains an acceptance obligation.
