# Companion runtime

The single-session coordinator hosts one provider session, supervises the state core, journals accepted state events, and exposes `SessionHostV1` to an in-process text client. The governing contract is the [Coordinator MVP design](../.nightshift/features/companion-execution-runtime.md#coordinator-mvp-design).

The real companion root was handed over to the runtime on 2026-10-13, followed by a live chat and graceful restart smoke test. The governing live cutover claims for a new in-game save, crash redelivery and bridge release remain unprobed. Mutating integration tests use private fixtures.

## Requirements and configuration

Use Windows, PowerShell 7.5 or later, and Node 22.23 or later. Install the dependencies with `npm --prefix runtime ci`. The lockfile pins `@anthropic-ai/claude-agent-sdk` to 0.3.289.

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

`chat` reports timestamped startup phases and elapsed time to the host's stderr stream. A 15-second timer emits a still-working update after the current phase has been quiet for at least 15 seconds; timer alignment and a busy event loop can delay it. Handled completion, ownership refusal and failure paths emit terminal outcomes, and chat readiness is announced only after the text client attaches. The progress data contains phase names and timing, not save content, credentials or paths. Programmatic callers can direct structured `StartupProgress` events to another sink through `runCli`'s progress callback. This reports waiting; it does not shorten startup. See [the startup phase guide](STARTUP.md) for each message.

The text client accepts one question at a time. `/think <question>` selects the configured per-question override; `/new` requests a new provider session; `/status` displays live status; `/quit` shuts down. Dialogs are answered within that same client. Attach, live changes and `/status` show operational warnings; a reaper discovery-limit warning names its `tmp` or `state` root and the stop, reduce and rerun remedy. The runtime never automatically resubmits a failed player message.

## State and recovery

The core owns `state/`, its consumer marker and durable outbox. Runtime-owned data lives under `runtime-data/`, partitioned by game and Windows principal. A process-lifetime guard excludes another writer for the same scope. Positive core acceptance is required before state is sent. A successful provider turn emits `turn.completed` before durable delivery acknowledgement advances the runtime cursor. The turn remains occupied while acknowledgement finishes; interruption after completion reports `noTurnInProgress`, and shutdown waits for that finalization. If acknowledgement fails, unacknowledged delivery remains available for replay.

Missing or uncertain authority fails closed. A pending settlement can produce a disclosure-only context for that interaction; later settlement helps a later interaction. Context invalidation survives restart and prevents reuse of provider history from an older generation. A successful repair alone does not clear the correction obligation.

The provider's default-profile transcript/configuration persistence is separate from runtime data. Native file-tool footprints remain unverified, so the production file-tool adapter refuses those operations. After a refused research-cache operation, hosted guidance discloses what could not be consulted or saved and uses the admitted context; it skips further cache work for that turn without queueing persistence. The [provider verification record](../.nightshift/reports/runtime-provider-verification.md) distinguishes observed behavior from remaining live claims.

## Verification

`npm --prefix runtime run typecheck` checks the TypeScript sources and tests. `npm --prefix runtime test` runs the Node test groups sequentially using private fixtures; native integration checks can take substantial time. The `runtime/test/Test-*.ps1` scripts exercise the native codecs, publication and process boundaries. The resource inventory fixture is under `runtime/test/resource-lifecycle/`.

The compiled images in `runtime/native/` are `go-broker.exe`, built from the module in `runtime/prototypes/go-process-broker/`, and `job-observer.exe`, built from `runtime/prototypes/job-observer.go`. Their Go unit tests are not part of `npm test`: run `go test ./...` in the broker module and `go test job-observer.go job-observer_test.go` in `runtime/prototypes/`. Each image is built with `go build -buildvcs=false -trimpath -ldflags=-buildid=` under `go1.26.0` for `windows/amd64` with `CGO_ENABLED=0`, the broker from `./cmd/go-broker` and the observer from `job-observer.go`; keep `GOCACHE`, `GOMODCACHE`, `GOPATH` and `GOTMPDIR` under the repository's `.tmp`. `runtime/native/compiled-images.json` records that toolchain, each image's size and SHA-256 and its LF-normalized source digests, and `runtime/src/compiled-image-release.ts` pins the manifest's own SHA-256 and both image hashes, so a rebuild updates all three together. `compiled-image-release.test.ts` and `release-go-broker.test.ts` check the packaged images and their sources against that release; the [Go broker README](prototypes/go-process-broker/README.md) states what the broker's own tests cover.

The live provider probes under `runtime/test/live/` make real requests using the configured provider and default profile. They are separate from the ordinary test command. Their outcomes do not establish game cutover, complete file-tool isolation, or the complete provider auxiliary-write footprint.

The [runtime timing record](../.nightshift/reports/runtime-timing-verification.md) distinguishes private integration and steady-state measurements from startup costs and unresolved acceptance work.
