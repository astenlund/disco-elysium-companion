# Go native helper fixture evidence, 2026-10-23

These private results exercise the [Go native helper](../features/runtime-powershell-dependency.md) MVP end to end through `runtime/test/support/selected-chat-main.ts`, the process-to-attachment timing fixture main, reworked onto the helper path. A harness kept in the delivery run's scratch folder under `.tmp` prepared each copied companion root and ran the fixture main as its own Node process. The harness is private and not committed.

## Method

Each copied root sits under the repository's `.tmp` and holds copies of `core`, the Disco Elysium adapter with its release, the runtime configuration with the watcher enabled, and the runtime-mode instructions. The adapter reads saves from a folder inside the copied root, and the harness hands consumption to the runtime through `Set-CompanionConsumer.ps1` and a backend consumer handover. It then stages the newest verified bench copy of a real save, keeping its write time; the real SaveGames folder is never read.

The harness runs the fixture main four times on the same root with a synthetic provider and no provider prestart: a new save completing one turn; an acknowledged restart completing one turn; a run killed as soon as it reports attachment; and an immediate restart after that kill, completing one turn. Every completed run ends with a graceful shutdown. Times run from the harness spawning the fixture process to receiving its healthy `attached` frame, so each is an upper bound on the startup it times. A sampler polls every 100 milliseconds for PowerShell processes and records the command line of each one that starts after sampling began.

## Results

The runs below measured commit `180acf3` on 2026-10-23, with the helper image already built and pinned; it was the branch's last runtime code change at the time. Later fixes on 2026-10-24 changed the CLI's companion-root handling, the image-read refusal reasons and the rebuild of an unreadable image, and re-pinned the helper after a source comment change, without a new fixture run, so the measured helper binary is not the one now pinned.

| Run | Attached healthy | Turn | Shutdown |
|---|---|---|---|
| New save | 13.8 s | 4.6 s | 0.2 s |
| Acknowledged restart | 5.5 s | 4.8 s | 0.1 s |
| Killed at attachment | 5.5 s | none | killed |
| Restart after the kill | 5.4 s | 4.7 s | 0.1 s |

Every completed run attached healthy, with the runtime as consumer, fresh state, ready safety, a healthy journal, a running watcher and a ready provider. While the service held the image, the fixture's write open of `companion-helper.exe` failed with `EBUSY` in every completed run. The marker the killed run left recorded `cleanShutdown: false` and its watcher's identity, and the restart started from that marker and reached attachment; the harness did not record whether that watcher was still running when the restart checked it. The staged save copy kept its hash and write time. Five earlier batches of the same four runs also passed, each before later fixes changed the runtime: at commit `bc2b929` they attached in 13.9, 5.6, 5.4 and 5.5 seconds in the same order, at commit `d7d5f99` in 15.0, 6.2, 6.2 and 6.0 seconds, at commit `f2f5e3f` in 18.9, 7.7, 7.6 and 7.8 seconds in the same order, at commit `fae8233` in 13.8, 6.2, 6.2 and 6.1 seconds, and on the same sources before `fae8233` was committed in 18.6, 7.5, 7.6 and 8.0 seconds. Attach times on this machine therefore vary between runs by several seconds, so these runs show that each path attaches healthy rather than a latency difference between commits.

The sampler observed the runtime starting PowerShell only for core entry scripts, the adapter's digest builder, the save watcher and retained core reply validation:

| Script | Processes |
|---|---|
| Core `Publish-StateEvent.ps1` | 7 |
| Core `Set-StateEventSettlement.ps1` | 1 |
| Core `Watch-Saves.ps1` | 4 |
| Adapter `Build-Digest.ps1` | 1 |
| Runtime `StartupCoreReplyWorker.ps1` | 4 |
| Runtime `Read-CoreReply.ps1` | 3 |

The sampler watches the whole machine without filtering. During this batch it also observed three PowerShell processes outside the runtime, left out of the list above: two runs of the Nightshift plugin's `windows-job-runner.ps1` from its clone under `C:/Git/nightshift`, and a user-level gateway watcher script outside the repository; none of them named the copied root or a runtime script. It polls every 100 milliseconds, so a process that started and exited between two samples would not appear; the list therefore does not prove that no other PowerShell process ran. The earlier batches at `bc2b929`, `d7d5f99`, `f2f5e3f` and `fae8233` observed the same runtime processes as above; this report does not record what the sampler observed during the batch run before `fae8233` was committed. During the `bc2b929` batch it observed no PowerShell process outside the runtime, during the `d7d5f99` batch one, the Nightshift plugin's `windows-job-runner.ps1` from its clone under `C:/Git/nightshift`, and during the `fae8233` batch it observed other tools on the machine starting PowerShell; none of them named the copied root or a runtime script.

## Coverage of the remaining acceptance fixtures

The other acceptance fixtures the MVP slice lists are committed tests: `runtime/test/native-helper.test.ts`, `native-helper-faults.test.ts`, `native-binding.test.ts`, `native-image.test.ts`, `client/chat-helper-lifecycle.test.ts`, the Go tests under `runtime/native/helper`, `client/orphan-watcher-start.test.ts`, which starts over a prior marker whose recorded watcher is still running and reaches attachment, and additions to `process.test.ts`, `platform/platform-native.test.ts`, `startup-core-reply-worker.test.ts` and `backend/fixtures/sent-mark-child.ts`. The C# reference vectors for the echoed request digests and replies of `hash` and `eventBatch` were captured from main's C# sources for synthetic inputs and are compared by `TestHashRepliesMatchTheCSharpVectors` and `TestEventBatchRepliesMatchTheCSharpVectors`. The fixture that has a second service read a target with `eventBatch` while chat's service replaces it is `native-helper-faults.test.ts`, which runs both services and repeats the race; the deterministic open-handle case, a reader held open with read, write and delete sharing across the replacement, is the Go test `TestPublicationReplacesUnderAnOpenReader`.
