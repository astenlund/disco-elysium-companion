# Live startup gate procedure

Written on 2026-11-16 for [Coordinator startup latency](../features/runtime-startup-latency.md). It describes the user-coordinated live measurement that the [acceptance matrix](../features/runtime-startup-execution-30.md#acceptance-matrix-and-decision-gate) leaves after the private gates; the private results it follows are in the [startup gate evidence](runtime-startup-gate-evidence-20261116.md). Nothing here has been run. The feature stays open until this measurement passes.

## Preconditions

- The private gates are recorded, and fresh independent code and documentation reviews of the work they measured are clean.
- The real companion root (this repository) is already owned by the runtime consumer. This study runs no consumer command on the real root; if a start reports another owner, stop and record it instead of switching.
- The game's own save folder stays read-only to everyone but the game: the tester saves only from inside the game, and copies, moves or deletes nothing there.
- The acceptance matrix also requires that provider initialization sends no model input, calls no tool and writes only within the approved provider-owned footprint. No established method in this repository proves that yet: the live provider probe at `runtime/test/live/probe-provider.ts` lists the default-profile auxiliary-write footprint and the native file-operation footprints as unverified. Until a method exists and passes, a live timing result is recorded but cannot close the gate.

## Timing and the healthy check

Run every start from a PowerShell prompt at the repository root, printing the wall clock immediately before launch:

```
Get-Date -Format o; node runtime/src/cli.ts chat
```

The start time is the printed timestamp. The end time is the timestamp on the `startup: chat client ready` progress line, which goes to stderr; its `elapsed` figure starts later, after the native image check, so do not use it as the launch-to-attachment time. Record the progress lines of every start, since they name the phases that limit a miss.

The status line the client prints right after attachment decides health. A counted healthy attachment shows `consumer: owner`, `state: fresh`, `journal: healthy`, `safety: ready` and `provider: ready`, and also has a running watcher. The client does not print the watcher (tracked as [Watcher state missing from the chat client readout](../BUGS.md)), so while the client is attached, check from a second prompt that its watcher process exists:

```
Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" | Where-Object { $_.CommandLine -like '*Watch-Saves.ps1*' } | Select-Object ProcessId, CreationDate, CommandLine
```

The process check shows that a watcher is running, not that it completed its startup observation, so record it as weaker evidence than a status readout. Verified startup-worker stop is not printed either; the [startup execution design](../features/runtime-startup-execution-30.md) withholds attachment on a failed or uncertain worker stop, so the private gates are the evidence for it, not this live check.

Any other status at attachment is a degraded or status-only attachment: record its time and status separately, and do not count it toward either target.

## Cases

Run each routine case at least three times and record every attempt, including misses.

1. **New save.** With chat closed, make a new manual save in the game, then start chat. The start publishes, journals and settles that save before attachment. Target: healthy within 30 seconds. Ask one short question so the turn is acknowledged, then `/quit`.
2. **Acknowledged restart.** After a session whose last turn completed, `/quit` and start chat again without saving in the game. Target: healthy within 30 seconds.
3. **Recovery.** After a healthy attachment, end the chat process abruptly by closing its terminal window, then start chat again. Target: healthy within 180 seconds. In the private gates this case recovered healthy in seconds from a settled predecessor; if the restart attaches with `safety: recovering`, record it as degraded, then record how many further starts and turns it takes to reach `safety: ready`.
4. **Status-only control (optional).** This deliberately leaves a correction on the real data root, so run it only if the user agrees. While a start shows the startup acquisition phase, stop the warm worker from a second prompt:

   ```
   Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" | Where-Object { $_.CommandLine -like '*StartupCoreReplyWorker.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId }
   ```

   In the private gates this start attached status-only with provider input withheld, and the following start attached degraded until one acknowledged turn returned safety to ready. Record the attachment time and status of each start until the status reads healthy again.

## Record

For each start, record the case, attempt number, launch timestamp, ready timestamp, launch-to-attachment seconds, the attachment status line, the watcher process check, and the progress lines. Both routine cases must repeatedly attach healthy within 30 seconds, and recovery must attach healthy within 180 seconds. A miss, an unmeasured case, an unapproved write or a failed proof leaves the feature open: record the limiting phases from the progress lines and bring the result back to the user without changing any readiness, settlement, watcher or safety check.
