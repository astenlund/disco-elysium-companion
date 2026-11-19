# Live startup gate procedure

Written on 2026-11-16 for [Coordinator startup latency](../features/runtime-startup-latency.md). It describes the user-coordinated live measurement that the [acceptance matrix](../features/runtime-startup-execution-30.md#acceptance-matrix-and-decision-gate) leaves after the private gates; the private results it follows are in the [startup gate evidence](runtime-startup-gate-evidence-20261116.md). Nothing here has been run. The feature stays open until this measurement passes.

## Preconditions

- The private gates are recorded, and fresh independent code and documentation reviews of the work they measured are clean.
- The [startup execution design](../features/runtime-startup-execution-30.md) also requires direct source and pre-guard write proof before the live measurement. The user recorded it as discharged on 2026-11-16 ([pre-guard write proof](runtime-pre-guard-write-proof-20261116.md)).
- The real companion root (this repository) is already owned by the runtime consumer. This study runs no consumer command on the real root; if a start reports another owner, stop and record it instead of switching.
- The game's own save folder stays read-only to everyone but the game: the tester saves only from inside the game, and copies, moves or deletes nothing there.
- The acceptance matrix also requires that provider initialization sends no model input, calls no tool and writes only within the approved provider-owned footprint. No established method in this repository proves that yet: the live provider probe at `runtime/test/live/probe-provider.ts` lists the default-profile auxiliary-write footprint and the native file-operation footprints as unverified. Until a method exists and passes, a live timing result is recorded but cannot close the gate.

## Timing and the healthy check

Run every start from a PowerShell prompt at the repository root, printing the wall clock immediately before launch:

```
Get-Date -Format o; node runtime/src/cli.ts chat
```

The start time is the printed timestamp. The end time is the timestamp on the `startup: chat client ready` progress line, which goes to stderr; its `elapsed` figure starts later, after the native image check, so do not use it as the launch-to-attachment time. Case 4 also needs the time its status turns healthy after the restart's turn: the client prints a status line at each status change but without a timestamp, so as soon as the line printed after the turn's answer shows `safety: ready` with the other healthy fields (run `/status` if none appears), take `Get-Date -Format o` in the second prompt and record it as the healthy timestamp, an upper bound on that instant. The launch timestamp is local time with its offset and the progress timestamp is UTC (ending in `Z`), so convert both to the same zone before subtracting, for example by parsing each with `[DateTimeOffset]::Parse`. Record the progress lines of every start, since they name the phases that limit a miss.

The status line the client prints right after attachment decides health. A counted healthy attachment shows `consumer: owner`, `state: fresh`, `journal: healthy`, `safety: ready`, `watcher: running` and `provider: ready`. Verified startup-worker stop is not printed; the [startup execution design](../features/runtime-startup-execution-30.md) withholds attachment on a failed or uncertain worker stop, so the private gates are the evidence for it, not this live check.

Any other status at attachment is a degraded or status-only attachment: record its time and status separately, and do not count it toward either target, except for the acquisition-kill recovery, whose degraded attachment counts once its first acknowledged turn makes it healthy, as case 4 describes.

## Cases

Run the new-save, acknowledged-restart and recovery cases at least three times each and record every attempt, including misses; case 4 needs the user's consent each time because it leaves a correction on the real data root, so its repeat count is the user's to set. After every `/quit`, record the exit code from the same prompt with `$LASTEXITCODE`: a normal entry-point exit is 0, and any other value is a failed exit to record with its output.

1. **New save.** With chat closed, make a new manual save in the game, then start chat. The start publishes, journals and settles that save before attachment. Target: healthy within 30 seconds. Ask one short question so the turn is acknowledged, then `/quit`.
2. **Acknowledged restart.** After a session whose last turn completed, `/quit` and start chat again without saving in the game. Target: healthy within 30 seconds.
3. **Recovery.** After a healthy attachment, end the chat process abruptly by closing its terminal window, then start chat again. Target: healthy within 180 seconds. In the private gates this case recovered healthy in seconds from a settled predecessor, but there the harness killed only the chat's Node process, while closing a terminal window ends every process attached to that console, so the outcome may differ; if the restart attaches with `safety: recovering`, record it as degraded, then record how many further starts and turns it takes to reach `safety: ready`.
4. **Acquisition-kill recovery, formerly the status-only control.** The acceptance matrix requires status-only controls, which this case no longer produces (see below), so the gate stays open until a reachable status-only trigger is found; on 2026-11-17 the user decided to search for one. This case deliberately leaves a correction on the real data root, so run it only if the user agrees. Make a new manual save in the game first: the start then publishes and settles it during acquisition, which lengthened that phase to about 11 seconds in the private gates, against about 3 seconds without one. While the start's progress shows `acquiring current state`, stop the real root's warm worker from a second prompt, and only when exactly one worker matches. The runtime starts each startup worker with `-CompanionRoot <root>` followed by `-DataRoot`, while private fixture roots live under this repository's `.tmp`, so the query requires exactly the real root as that argument, which leaves out fixture roots and any sibling folder whose name starts the same way:

   ```
   $root = 'C:\Git\disco-elysium-companion'
   function Get-RootProcess([string]$Script) { @(Get-CimInstance Win32_Process -Filter "Name = 'pwsh.exe'" | Where-Object { $_.CommandLine -like "*$Script*" -and ($_.CommandLine -like "*-CompanionRoot $root" -or $_.CommandLine -like "*-CompanionRoot $root -*") }) }
   $workers = Get-RootProcess 'StartupCoreReplyWorker.ps1'
   if ($workers.Count -eq 1) { Stop-Process -Id $workers[0].ProcessId } else { "Found $($workers.Count) workers; stopping none." }
   ```

   The private gates killed the worker during an acquisition with no newly detected save, so a kill while a new save is being published is a condition they did not cover, and its outcome and the correction it leaves may differ; record them as observed. In the private gates before the fix of "Recovery needs extra starts or a turn before it is healthy" (see [bug history](../BUGS_HISTORY.md)) this start attached status-only with provider input withheld; since that fix the gates' acquisition kill attaches degraded with a ready provider and `recovering` safety, and the restart's first acknowledged turn returns status to healthy. This case therefore no longer produces a status-only control: run it as the acquisition-kill recovery: once the fault start attaches, record its status, `/quit` it, start chat again as above, ask one short question on that restart, and record the attachment time and status of each start and the time the status reads healthy, which must be within 180 seconds of the restart's launch. A start that still attaches status-only is recorded as observed. No other way to produce a live status-only control has been found; the user decided on 2026-11-17 to search for one, as [Coordinator startup latency](../features/runtime-startup-latency.md) records, and until one is found the control stays unrun. If the kill lands outside that phase, record the progress line it followed and the outcome: in the private gates a kill before acquisition failed the start closed with `Startup worker transport is unavailable.` instead of attaching status-only, and a repeat attempt is needed.

## Record

For each start, record the case, attempt number, launch timestamp, ready timestamp, launch-to-attachment seconds, the attachment status line, the progress lines, for case 4 the healthy timestamp after the turn and its launch-to-healthy seconds, and, for a session ended with `/quit`, its exit code. Both routine cases must repeatedly attach healthy within 30 seconds, case 3 must repeatedly attach healthy within 180 seconds, each user-consented run of case 4 must reach healthy within 180 seconds of the restart's launch through a ready attachment and its first acknowledged turn, every `/quit` must exit with 0, and a status-only control must have been run and recorded; until a trigger for it is found the gate stays open. A miss, an unmeasured case, an unapproved write or a failed proof leaves the feature open: record the limiting phases from the progress lines and bring the result back to the user without changing any readiness, settlement, watcher or safety check.
