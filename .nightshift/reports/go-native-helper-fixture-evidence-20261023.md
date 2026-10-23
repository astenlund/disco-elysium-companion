# Go native helper fixture evidence, 2026-10-23

These private results exercise the [Go native helper](../features/runtime-powershell-dependency.md) MVP end to end through `runtime/test/support/selected-chat-main.ts`, the process-to-attachment timing fixture main, reworked onto the helper path. A harness kept in the delivery run's scratch folder under `.tmp` prepared each copied companion root and ran the fixture main as its own Node process. The harness is private and not committed.

## Method

Each copied root sits under the repository's `.tmp` and holds copies of `core`, the Disco Elysium adapter with its release, the runtime configuration with the watcher enabled, and the runtime-mode instructions. The adapter reads saves from a folder inside the copied root, and the harness hands consumption to the runtime through `Set-CompanionConsumer.ps1` and a backend consumer handover. It then stages the newest verified bench copy of a real save, keeping its write time; the real SaveGames folder is never read.

The harness runs the fixture main four times on the same root with a synthetic provider and no provider prestart: a new save completing one turn; an acknowledged restart completing one turn; a run killed as soon as it reports attachment; and an immediate restart after that kill, completing one turn. Every completed run ends with a graceful shutdown. Times run from the harness spawning the fixture process to receiving its healthy `attached` frame, so each is an upper bound on the startup it times. A sampler polls every 100 milliseconds for PowerShell processes and records the command line of each one that starts after sampling began.

## Results

The runs below measured commit `f2f5e3f` on 2026-10-23, the head of the delivered branch, with the helper image already built and pinned.

| Run | Attached healthy | Turn | Shutdown |
|---|---|---|---|
| New save | 18.9 s | 7.0 s | 0.3 s |
| Acknowledged restart | 7.7 s | 6.7 s | 0.3 s |
| Killed at attachment | 7.6 s | none | killed |
| Restart after the kill | 7.8 s | 6.6 s | 0.3 s |

Every completed run attached healthy, with the runtime as consumer, fresh state, ready safety, a healthy journal, a running watcher and a ready provider. While the service held the image, the fixture's write open of `companion-helper.exe` failed with `EBUSY` in every completed run. The marker the killed run left recorded `cleanShutdown: false` and its watcher's identity, and the restart started from that marker and reached attachment; the harness did not record whether that watcher was still running when the restart checked it. The staged save copy kept its hash and write time. Two earlier runs of the same harness also passed: one at commit `fae8233`, before later fixes changed the service's start arguments and request handling, attached in 13.8, 6.2, 6.2 and 6.1 seconds in the same order, and one on the same sources before that commit attached in 18.6, 7.5, 7.6 and 8.0 seconds. Attach times on this machine therefore vary between runs by several seconds, so these runs show that each path attaches healthy rather than a latency difference between commits.

The runtime started PowerShell only for core entry scripts, the adapter's digest builder, the save watcher and retained core reply validation:

| Script | Processes |
|---|---|
| Core `Publish-StateEvent.ps1` | 7 |
| Core `Set-StateEventSettlement.ps1` | 1 |
| Core `Watch-Saves.ps1` | 4 |
| Adapter `Build-Digest.ps1` | 1 |
| Runtime `StartupCoreReplyWorker.ps1` | 4 |
| Runtime `Read-CoreReply.ps1` | 3 |

The sampler watches the whole machine without filtering, and during this run no other PowerShell process started on it, so the list above is every PowerShell process the machine started while the runs were sampled. During the earlier run at `fae8233`, other tools on the machine also started PowerShell, none of them naming the copied root or a runtime script, and the runtime's own processes were the same as above.

## Coverage of the remaining acceptance fixtures

The other acceptance fixtures the MVP slice lists are committed tests: `runtime/test/native-helper.test.ts`, `native-helper-faults.test.ts`, `native-binding.test.ts`, `native-image.test.ts`, `client/chat-helper-lifecycle.test.ts`, the Go tests under `runtime/native/helper`, and additions to `process.test.ts`, `platform/platform-native.test.ts`, `startup-core-reply-worker.test.ts` and `backend/fixtures/sent-mark-child.ts`. The C# reference vectors for the echoed request digests and replies of `hash` and `eventBatch` were captured from main's C# sources for synthetic inputs and are compared by `TestHashRepliesMatchTheCSharpVectors` and `TestEventBatchRepliesMatchTheCSharpVectors`. The fixture that has a second service read a target with `eventBatch` while chat's service replaces it is `native-helper-faults.test.ts`, which runs both services and repeats the race; the deterministic open-handle case, a reader held open with read, write and delete sharing across the replacement, is the Go test `TestPublicationReplacesUnderAnOpenReader`.
