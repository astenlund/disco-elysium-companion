# Core command startup feasibility

The user retained a healthy 30-second `chat` target for routine clean starts, including a newly detected save requiring publication and settlement, and acknowledged restarts. Healthy recovery retains 180 seconds. This separate slice investigated whether warming core commands could close part of the gap without changing the existing process-stop and journal safety proofs. It used only private repository fixtures and changed no production runtime or core file. The best earlier combined fresh-save fixture reached a synthetic fake-provider-bound and verified-stop boundary in 47.588 seconds, without a real provider or client attachment.

## Governing boundary

The runtime [Core supervision](../features/companion-execution-runtime.md#core-supervision) rule says, "The runtime runs core entry scripts as child processes through one queue." Current `CoreClient.invoke` starts one supervised `core` child per command, validates its captured reply separately, and `Kernel.checked` clears the pending safety check only after `verifyQuiescent('core')` succeeds following the acceptance callback. Publish can commit a core outbox record before its baseline advances. The runtime then reads and durably appends that record to its journal before it calls Settlement with the record's exact journal binding. [State extraction section 7.6](../features/state-extraction.md) defines the partial durable states and settlement recovery. This slice kept those transitions separate.

## Private single-use measurements

The private wrapper starts `pwsh` early, writes a ready token, waits for one bounded matching request, invokes the unchanged staged core entry script once with the same arguments, then exits. It does not stay alive between Publish and Settlement. The [Publish result](../../.tmp/p2/result.json) and [Settlement result](../../.tmp/startup-core/single-use-result.json) come from separate fixture shapes. Times are milliseconds and each pair is one restored private-state comparison:

| Operation | Pair | One-shot full lifetime | Warm full lifetime | Warm ready time | Warm request to exit |
|---|---:|---:|---:|---:|---:|
| Publish | 1 | 4381.6 | 4400.4 | 171.7 | 4229.1 |
| Publish | 2 | 4526.3 | 4381.4 | 166.5 | 4214.9 |
| Settlement | 1 | 1306.0 | 1342.8 | 202.5 | 1140.8 |
| Settlement | 2 | 1297.5 | 1291.5 | 184.7 | 1106.8 |

All four Publish attempts exited 0, stopped, returned empty stderr and reported the same committed consumed outcome, logical outbox sequence, baseline apply and cache status. The save bytes and saved time were frozen across attempts. The raw receipts and event records naturally had different minted times; the fixture compared normalized receipts and per-file state hashes after replacing string values only under `generatedAt`, `currentGeneratedAt`, `baselineGeneratedAt`, `createdAt` and `settledAt`. It did not normalize IDs or hashes. The retained save and initial record match the source and initial-record hashes in the result. The four raw post-run states were not retained for an independent byte comparison.

All four Settlement attempts exited 0, stopped and returned identical stdout and stderr. The fixture compared complete private state fingerprints after normalizing the independently minted ledger `settledAt` value; its saved summary omits raw stderr and per-file hashes, so that parity depends on the script's successful comparison path. Both probes used a private stub adapter. Neither exercised runtime `ProcessSupervisor` admission, `Kernel.checked` safety clearance, the runtime journal append, crash and lost-reply branches, or a real game save.

The full warm lifetimes were near their paired one-shot lifetimes. Starting early moved roughly 0.17 to 0.20 seconds before each request but did not demonstrate a saving above one second for either tested command. Two pairs do not establish a performance distribution or rule out other safe optimizations.

## Design outcome

A process that executes both core commands while remaining alive across the journal append cannot satisfy the existing literal core-job absence check. It would require a separately specified per-request idle proof, source and lock lifetime, unknown-consumption recovery and startup/shutdown role lifecycle that replace that check. That is a material safety-contract change, not a drop-in startup optimization under this slice. Keeping the current proof permits a single-use process, but this private version showed no material full-lifetime saving. No production core-host implementation is selected from these results. The healthy 30-second target remains open; a later investigation can measure avoidable work inside Publish and the broader acquisition path, or the user can separately authorize a new safety-proof design. Neither option is asserted to meet 30 seconds yet.
