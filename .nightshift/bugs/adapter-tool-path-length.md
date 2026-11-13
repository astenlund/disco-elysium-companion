# Adapter tool path length

Tracked from Nightshift run a69edaac-e54c-47ec-ba9c-3e2c5bb3418d (2026-11-13), which added the companion-root length admission ([Deep helper working directories](runtime-helper-cwd-length.md)).

## Recorded evidence

The runtime's installation bound (`installationRootBound` in `runtime/src/launch-directory.ts`, 223 characters for `disco_elysium`) covers the launches the runtime makes itself and the working directory of the core's adapter commands (`adapters/<adapter>`), the latter assuming the 258-character working-directory limit that was measured for Node spawn and the Go broker, not for the core's .NET launch. It does not cover adapter tools that the PowerShell core starts from inside the core-resolved adapter release folder: the Disco Elysium dump tool is `{artifactRoot}/adapters/disco_elysium/dump-tool/dedump.exe`, where `artifactRoot` is `adapters/disco_elysium/releases/<version>/schema-<n>`, about 87 characters below the companion root. The run measured executable-path limits only for Node's `child_process.spawn` (259 characters started, 260 failed) and the Go broker (270 characters started), on one host with long paths enabled. The core's .NET process launch was not measured, so it is unknown whether a root of roughly 173 to 223 characters actually fails at the dump stage; if it does, the user would see the core's generic `command-start-failed` rather than a length message.

## Follow-up

First measure the executable-path and working-directory limits of the core's adapter command launch at the boundary; the working-directory measurement also confirms or corrects the adapter term of `installationRootBound`, which would need adjusting if the core's limit is lower. Only if a limit applies, add a fail-closed length check with its own message where the adapter configuration is resolved and `artifactRoot` is known, so the bridge and runtime paths both refuse a too-long root before the dump stage.

## Status

The user chose to track this item on 2026-11-13. No fix was authorized by that choice.
