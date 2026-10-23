# Companion runtime

The single-session coordinator hosts one provider session, supervises the state core, journals accepted state events, and exposes `SessionHostV1` to an in-process text client. The governing contract is the [Coordinator MVP design](../.nightshift/features/companion-execution-runtime.md#coordinator-mvp-design).

The real companion root was handed over to the runtime on 2026-10-13, followed by a live chat and graceful restart smoke test. The governing live cutover claims for a new in-game save, crash redelivery and bridge release remain unprobed. Mutating integration tests use private fixtures.

## Requirements and configuration

Use Windows, Node 22.23 or later, Go `go1.26.0` on `PATH`, and PowerShell 7.5 or later, which the state core and core reply validation still need. Install the dependencies with `npm --prefix runtime ci`. The lockfile pins `@anthropic-ai/claude-agent-sdk` to 0.3.289. No native binary is committed: the first `chat`, `consumer` or `repair` builds the native helper, as [Native helper](#native-helper) describes.

`companion.config.json` chooses the adapter, game, provider model/effort, optional question override, and watcher setting. Unknown members or invalid values are rejected. The provider uses the existing default-profile authentication setup. Status displays the SDK's API-key source; `none` leaves the non-API-key method unspecified. An inherited `CLAUDE_CONFIG_DIR` is unsupported and prevents provider startup; the runtime requires the default profile. Supported credential variables continue to pass through to the provider.

The executable resolves the companion root from its own installation directory. It has no command-line root override. Tests use the programmatic root parameter and private fixtures.

## Commands

Run the entry point as `node runtime/src/cli.ts <command>` from the companion checkout.

| Command | Effect |
|---|---|
| `status` | Reads persisted status without taking the runtime writer guard or running a core command. Volatile chat values are reported unavailable. |
| `chat` or no argument | Starts the coordinator and text client. It refuses state consumption when the runtime does not own it. |
| `consumer runtime` | Explicitly transfers consumption to the runtime through the core ownership command. |
| `consumer bridge` | Attempts confirmed release to the bridge while preserving undelivered obligations. |
| `consumer bridge --abandon-undelivered` | Performs explicit abandon release, preserving correction and recovery evidence as required by the design. |
| `repair` | Runs startup reconciliation and repair under runtime ownership. |

The consumer and repair commands mutate state. Installing the runtime or reading status does not transfer consumption.

When a first-launch build runs, `chat`, `consumer` and `repair` first report the `nativeBuild` phase on the host's stderr stream until the build ends with `native helper built` or `failed`. `chat` then reports timestamped startup phases and elapsed time to the same stream. A 15-second timer emits a still-working update after the current phase has been quiet for at least 15 seconds; timer alignment and a busy event loop can delay it. Handled completion, ownership refusal and failure paths emit terminal outcomes, and chat readiness is announced only after the text client attaches. The progress data contains phase names and timing, not save content, credentials or paths. Programmatic callers can direct structured `StartupProgress` events to another sink through `runCli`'s progress callback. This reports waiting; it does not shorten startup. See [the startup phase guide](STARTUP.md) for each message.

The text client accepts one question at a time. `/think <question>` selects the configured per-question override; `/new` requests a new provider session; `/status` displays live status; `/quit` shuts down. Dialogs are answered within that same client. Attach, live changes and `/status` show operational warnings; a reaper discovery-limit warning names its `tmp` or `state` root and the stop, reduce and rerun remedy. The runtime never automatically resubmits a failed player message.

## State and recovery

The core owns `state/`, its consumer marker and durable outbox. Runtime-owned data lives under `runtime-data/`, partitioned by game and Windows principal. A process-lifetime guard excludes another writer for the same scope. Positive core acceptance is required before state is sent. A successful provider turn emits `turn.completed` before durable delivery acknowledgement advances the runtime cursor. The turn remains occupied while acknowledgement finishes; interruption after completion reports `noTurnInProgress`, and shutdown waits for that finalization. If acknowledgement fails, unacknowledged delivery remains available for replay.

Missing or uncertain authority fails closed. A pending settlement can produce a disclosure-only context for that interaction; later settlement helps a later interaction. Context invalidation survives restart and prevents reuse of provider history from an older generation. A successful repair alone does not clear the correction obligation.

The provider's default-profile transcript/configuration persistence is separate from runtime data. Native file-tool footprints remain unverified, so the production file-tool adapter refuses those operations. After a refused research-cache operation, hosted guidance discloses what could not be consulted or saved and uses the admitted context; it skips further cache work for that turn without queueing persistence. The [provider verification record](../.nightshift/reports/runtime-provider-verification.md) distinguishes observed behavior from remaining live claims.

## Verification

`npm --prefix runtime run typecheck` checks the TypeScript sources and tests. `npm --prefix runtime test` runs the Node test groups sequentially using private fixtures; native integration checks can take substantial time. The remaining `runtime/test/Test-*.ps1` scripts exercise the C# path admission, payload codec and publication sources that core reply validation still loads.

## Native helper

Every native operation of the runtime, apart from core reply validation, runs in one Go executable, `runtime/native/companion-helper.exe`, built from the module in `runtime/native/helper/` with only the Go standard library. Started as `service` it is the long-lived helper service of one runtime process, and started as `broker` it launches one supervised child inside its own kill-on-close job. The [Go native helper design](../.nightshift/features/runtime-powershell-dependency.md) governs both.

The image is git-ignored and built on first launch. `chat`, `consumer` and `repair` first check that every helper source matches `runtime/native/compiled-images.json`, then use a present image whose SHA-256 matches the pin, and otherwise build it with `go build -buildvcs=false -trimpath -ldflags=-buildid=` for `windows/amd64`. The build runs in an environment built from scratch: `SystemRoot`, a `PATH` holding only the resolved `go` directory, the target variables, `CGO_ENABLED=0`, `GOENV=off`, `GOTOOLCHAIN=local`, `GOWORK=off`, an empty `GOFLAGS`, and every profile, temporary and cache location inside a build directory under `.tmp/native-build`, with Go telemetry turned off through its mode file there. No other variable reaches the toolchain, so ambient Go settings cannot change the output; the only write outside `.tmp` is the create-only publication of the image. A build that cannot complete refuses with `nativeHelperUnavailable` and names its reason and remedy. `status` never builds: it refuses when the image is absent, fails its pin or does not match the sources.

`runtime/src/compiled-image-release.ts` pins the manifest's own SHA-256 and the image's, and `runtime/test/compiled-image-release.test.ts` repeats both. After changing a helper source, run `node runtime/tools/pin-native-helper.ts`, which rebuilds the image in the same environment and rewrites the manifest and both pins together; a reviewer verifies a pin by running the same tool on the same commit. `compiled-image-release.test.ts` checks the manifest against the checkout and rebuilds the image into a private `.tmp` folder to confirm the pin. The Go unit tests are not part of `npm test`: run `go test ./...` in `runtime/native/helper` with the same `GOENV`, `GOTOOLCHAIN`, `GOFLAGS` and contained cache, profile and temporary locations.

The live provider probes under `runtime/test/live/` make real requests using the configured provider and default profile. They are separate from the ordinary test command. Their outcomes do not establish game cutover, complete file-tool isolation, or the complete provider auxiliary-write footprint.

The [runtime timing record](../.nightshift/reports/runtime-timing-verification.md) distinguishes private integration and steady-state measurements from startup costs and unresolved acceptance work.
