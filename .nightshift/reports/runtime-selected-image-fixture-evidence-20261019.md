# Selected-image fixture evidence, 2026-10-19

These private results exercise the source-bound compiled-image path end to end through `runtime/test/support/selected-chat-main.ts`, the private fixture main that the governing [startup design](../features/runtime-startup-execution-30.md) admitted on 2026-10-19. Each run spawns the fixture main as its own Node process against a copied companion root, with the worktree as the admitted installation and image root, a synthetic provider backed by a real supervised `provider` child, and the in-memory verified client attachment. The product CLI selector stays off. The harness lives in `.tmp/cc-eefa8669/harness/` and copies saves only from the verified bench copies under `.tmp/p6a17/.tmp/ownedrefresh17/bench/real-saves`; the original SaveGames folder was not read. Every run proved all process roles stopped for the copied root and its data scope, compared the staged save and the bench copies before and after, and checked the durable journal, cursor, binding, marker and safety records for its mode.

## Timing

Times are from the harness spawning the fixture process to receiving its healthy `attached` frame. The fixture's `prestart` argument selects the private unbound provider prestart; the product CLI does not prestart, so `no-prestart` is the configuration that matters for the selector.

| Configuration and source commit | New save | Acknowledged restart |
|---|---|---|
| Prestart, `3edf6df` (the first new save and its restart) and `8f9d509` | 28.3, 29.0, 29.2, 29.5 s | 20.7, 21.1, 21.5, 21.1, 20.6, 21.2, 20.5 s |
| No prestart, `658b086` | 27.9, 27.7 s; 28.9 s with kernel tracing active | 20.1, 21.9, 20.6, 20.6 s |
| No prestart, `dca5a4d` (after the review repairs) | 28.2, 29.5 s | 19.9, 20.1, 21.0, 21.4 s |
| No prestart, `021b959` (later repairs and rebuilt images) | 27.5, 27.4 s | 20.1, 19.9, 20.6, 20.1 s |
| No prestart, `928ab4b` (final attachment and phase D-H changes), later that evening | 36.4, 31.0, 39.0 s | 20.5, 27.9, 22.3, 21.5, 25.8, 26.2 s |
| No prestart, `021b959` again, as an A/B control right after the row above | 36.0 s | 24.2, 24.5 s |

The last two rows show a slowdown of the machine, not of the code. Later the same evening, `928ab4b` attached new saves in 31.0 to 39.0 seconds, missing the 30-second target. About half of its added time sat in startup acquisition, which no change since `021b959` touched, every other phase slowed somewhat, and the absent-image fallback slowed by a similar amount. An A/B rerun of `021b959` right afterwards reproduced the slowdown. Between those runs processor load sampled at 4 percent, no trace session was running and memory was ample; the cause was not found. The 30-second margin of the earlier rows therefore depends on machine state.

The first two rows were measured before the independent review's repairs changed code on this path; the `dca5a4d` row re-measured the repaired code, and the `021b959` row re-measured after a later review round, which also rebuilt both compiled images. Every earlier row ran a Go broker that always exited 0 whatever its child returned; the passing healthy runs did not expose that. The rebuild replaced broker `aa52d71f...` and observer `bb381859...`, the images the 2026-10-18 reports name, with broker `7115c9da...` (3,491,328 bytes) and observer `f2301be4...` (3,076,096 bytes). Only the run reports from the `dca5a4d` row onward record their source commit. The commits named for the first two rows, and for the absent-fallback runs below that record none, are inferred by placing each report's write time between commit times, which assumes the worktree had no uncommitted change during the run; the harness did not check that then, and now refuses uncommitted tracked changes and records the commit. All 42 image-backed runs in the table passed. One further retained restart, at 21.2 seconds, passed while review repairs were in progress, 46 seconds before the next commit; its source is uncertain, so the table leaves it out. With a synthetic provider, prestart showed no saving. In the two new-save runs whose phase marks were inspected, startup acquisition took 11.7 and 12.5 seconds, against 3.6 seconds in an inspected restart, and before the slowdown untraced new saves attached within 0.5 to 2.6 seconds of the 30-second target. The real SDK's start cost is unmeasured, so these figures do not establish the target. The absent-image fallback was timed by the fixture's own process clock rather than the harness spawn clock: on restart it attached healthy at 28.9, 28.1 and 28.0 seconds on `658b086`, `0b04533` and `6ad4d73`, at 27.4 seconds in a run made while review repairs were in progress, whose source is therefore uncertain, at 29.2 seconds on `dca5a4d`, at 27.6 seconds on `1cd254f` and at 28.4 seconds on `021b959`, against 19.2 to 21.0 seconds on that same clock with images, suggesting the compiled images save roughly 6 to 10 seconds of restart on this machine. During the slowdown it attached at 35.9 seconds on `928ab4b`; that run is left out of the saving estimate.

## Pins and shutdown

Every image-backed run returned a ready pin set. After `host.shutdown()` stopped every role, write opens of both pinned executables failed with `EBUSY` while the fixture process lived, and the harness then opened both for write after the process exited. No run left an executable write lock behind. Release of the ancestor-directory rename restriction after exit, which the governing spec also requires, was not checked.

## Negative cases

Each case builds a damaged copy of the image root inside the installation, runs the fixture main in the product configuration against an already-run copied root, and requires the refusal reason, and in every refusal case except the foreign-root one a pattern in its bounded detail, to match the intended check. The hard-link pattern also accepts the generic incomplete-release detail, and the foreign-root case checks only its `invalidInputs` reason, which several input checks share; the recorded details still name the intended cause in every case. Refusals after the transfer mark keep the pin obligation unknown, so the fixture exits hard. In every refusal case the copied data scope was byte-identical before and after, all roles were stopped, and no executable in the damaged image root stayed locked. The table records the pass on `928ab4b`, with the rebuilt images; each of its eleven reports records that commit, and the earlier passes on `1cd254f` and `021b959` gave the same pin states and reasons.

| Case | Pins | Refusal reason |
|---|---|---|
| Bootstrap script changed after release | idle | `sourceChanged`, `runtime/scripts/Get-BootstrapScope.ps1` |
| Image root outside the installation | idle | `invalidInputs` |
| Broker and manifest present, observer absent | unknown | `Image pin release is incomplete or invalid.` |
| Manifest alone | unknown | `Image pin release is incomplete or invalid.` |
| Observer slot is a directory | unknown | `Image pin release is incomplete or invalid.` |
| Manifest slot is a directory | unknown | `Image pin release is incomplete or invalid.` |
| Broker hard-linked | unknown | `File link count is not exactly one.` |
| Observer bytes changed | unknown | `Image pin executable bytes differ from release.` |
| Manifest bytes changed | unknown | `Image pin release generation changed.` |
| `runtime/native` redirected through a junction | unknown | `Reparse objects are not admitted.` |
| All three slots absent | absent | none; slower path attached healthy |

The helper previously replaced every exception with one fixed token. `Get-BootstrapScope.ps1` now reports the innermost exception type and message after the fixed `Get-BootstrapScope: bootstrap-unavailable: ` prefix, with that reason text cut to 160 printable characters, and Node keeps the last 240 printable characters of the helper's stderr as the refusal detail. `SourceBoundBootstrapError` carries the reason code and bounded detail under the phase-A `dataRootUnavailable` code, and its player-facing message is unchanged.

## Write containment

One no-prestart new-save ran under an elevated NT Kernel Logger session (`PROC_THREAD`, `LOADER`, `FILE_IO`, `FILE_IO_INIT`, `FILENAME`) started and stopped through `gsudo` with the user's approval; the run itself was unelevated. The merged trace covers 2 minutes 57 seconds with 0 lost buffers and 0 lost events. The fixture main's process tree held 1,039 processes: 2 `node.exe`, 425 `conhost.exe`, 196 `pwsh.exe`, 228 `job-observer.exe`, 187 `go-broker.exe` and 1 `dedump.exe`. Write-class operations are writes, deletes, renames, security and extended-attribute changes, set-information classes that alter a file, and creates whose disposition can create or overwrite. They are attributed to the tree when a tree process issues them, or when the System lazy writer flushes a file object a tree process currently holds open.

Apart from file-system journaling, tree processes issued no write-class operation outside the repository. 7,794,677 operations landed inside it, and 173 more, also attributed to tree processes, were NTFS `$LogFile` and `$Mft` journaling that the file system performs itself. Three single System lazy-writer flushes outside the repository were attributed through reused kernel file-object addresses to files owned by other software running at the time: a Hermes Nightshift status file, a Claude Code hook marker and an unrelated temporary folder. No tree process created or wrote them directly. The analyzer and its report are `.tmp/cc-eefa8669/harness/analyze-trace.mjs` and `.tmp/cc-eefa8669/w/writes-r-75f7b7c3-v2.json`. This covers the whole run, including the pre-guard interval and bootstrap; it covers one new-save run with a synthetic provider, not a restart, a failure path or the real SDK's provider-owned footprint. Because it traced the fixture main rather than the direct CLI entry, it does not by itself discharge the governing spec's direct-CLI pre-guard write proof. It also ran on the images released before the later rebuild, so the rebuilt images have not been traced.

## Other observations

The three no-prestart new-save runs on `658b086` recorded their one acknowledged turn at 122.5, 123.3 and 125.0 seconds, the last of them under kernel tracing, the two on `dca5a4d` at 120.1 and 127.0 seconds, and the two on `021b959` at 133.8 and 127.3 seconds, with a provider that answers immediately; during the later slowdown, turns took 135.3, 142.7 and 137.7 seconds on `928ab4b` and 136.1 seconds on the `021b959` control. That fits, though it does not yet confirm, the post-acquisition journal drain in `runtime/src/backend/delivery.ts` running until its 120-second settlement budget expires; this belongs to [Coordinator whole-turn latency](../features/runtime-interaction-latency.md). The helper `pwsh` processes issued about 7.8 million write operations to PowerShell's `StartupProfileData-NonInteractive` JIT profile in the per-start helper profile during the traced run, and because every chat start creates a new `runtime-startup-*` profile, no start can reuse a warm profile and the folders accumulate under the installation's `.tmp`. Earlier private build probes gave each `dotnet` and `go` build a fresh `DOTNET_CLI_HOME`; the SDK treated each as a first run, leaving 62 `toolpath` first-run markers, one for each tools folder it appends to the persistent user PATH, which overflowed it. Every runtime helper, broker and test environment that redirects the .NET home now also sets `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false` and `DOTNET_GENERATE_ASPNET_CERTIFICATE=false`.

## Injected faults

The user chose to cover the fault cases without adding fault hooks to the hash-pinned helper. `runtime/test/Test-NativeImagePins.ps1` drives the native pin primitives against real processes and passed three consecutive runs; a later set of three consecutive passes on the tree of `021b959` kept its logs under `.tmp/cc-eefa8669/native-pins-r5/`. It covers the following:

- A target whose creation identity differs by one tick is refused before any duplication.
- A partial transfer into a live target rolls back, and both files are writable again.
- A target killed mid-transfer makes the next duplication and the rollback close both fail, yet the operating system released the pin it already held.
- A helper that transfers a pin and exits without a receipt leaves the pin denying writes inside the target until the target exits hard, which releases it.
- Replacing a file with identical bytes keeps its path and hash but changes the file identity that the helper's held-versus-admitted comparison checks.

`runtime/test/source-bound-bootstrap.test.ts` adds a late reply, job-stop uncertainty, no receipt and a truncated receipt, each refused after the transfer mark so the direct main's obligation stays unknown. The harness's `guard-loss.mjs`, run on the images released before the later rebuild, held the copied scope's instance guard while the fixture main started: the pins were verified ready, the guard claim then failed with `Another runtime owns this scope.`, the fixture exited 1 under the hard-exit obligation, the data scope was byte-identical, every role was stopped and both executables were writable afterwards. The composite rollback flow inside `BootstrapImagePins.ps1` is exercised through its primitives rather than end to end, and same-hash replacement inside `OpenHeld`'s own admission-to-open window is covered by the property it relies on, not by winning that race.

## Still open

These gates remain open, each defined in the governing spec:

- The direct-CLI pre-guard write proof. The trace above covered one fixture-main new save, not the direct CLI, a restart or a failure path.
- Independent verification of source-to-binary provenance and the release-hash trust root.
- Go broker parity with the PowerShell broker it replaces.
- Launch from a non-canonical spelling of the installation path.
- The fast backend path's own acceptance matrix, which selection also enables.
- Release of the ancestor rename restriction after exit.
- Copied-save runs with ready pins of the remaining post-transfer states the spec lists: not-owner, provider refusal, status-only attachment and failed open. Healthy shutdown and, on the earlier images, guard loss have run.
- Clean fresh code and documentation reviews.
- Before any live run, the real SDK's default-profile footprint, with no model input and no tool call during initialization.
- User-coordinated real-provider new-save, acknowledged-restart and recovery runs.
- The decision to enable the selector.

The 30-second goal is not met until those real-provider runs repeatedly attach healthy within it.
