# .NET tools folders leak into the User PATH

## Recorded observation

On 2026-10-19, in a session working on another project (FeatherPod), a repository pre-commit hook's `npx eslint` failed with "not recognized" because the inherited PATH was longer than cmd's 8191-character limit, beyond which cmd treats PATH as empty. The persisted User-scope PATH was 10,267 characters over 109 entries. 71 of those entries (about 8,715 characters) were `.dotnet\tools` folders under this repository's `.tmp`, such as `C:\Git\disco-elysium-companion\.tmp\startup-target-30\dotnet-home\.dotnet\tools` and `C:\Git\disco-elysium-companion\.tmp\pv17-6d82\.tmp\proof-6d82\run-first-20261018-6d82\a\dotnet-home\.dotnet\tools`, and none of those folders existed any more. Some folder names carry the date 20261018, so the entries are still accumulating, and every new session on the machine inherits the bloated PATH.

## Cause (attributed, not confirmed)

Test or probe runs here point `DOTNET_CLI_HOME` at a fresh `.tmp` folder, and the .NET SDK's first-run step then adds that folder's `.dotnet\tools` directory to the User PATH; `DOTNET_SKIP_FIRST_TIME_EXPERIENCE` alone does not prevent it, while `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false` is expected to. The partial fix below acts on this attribution, but no run has yet been checked against the User PATH before and after. The project memory note `memory/projects/dotnet-first-run-probe.md` records a related first-run side effect of a `DOTNET_CLI_HOME` redirect (a reported HTTPS development certificate install).

## Partial fix

The startup execution work, merged into main on 2026-10-20, added `dotnetFirstRunOptOuts` in `runtime/src/dotnet-environment.ts`, which sets `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false` and `DOTNET_GENERATE_ASPNET_CERTIFICATE=false` among other first-run opt-outs. Every tracked site that redirects `DOTNET_CLI_HOME` applies it: the helper scratch environment in `runtime/src/startup-helper-scratch.ts`, the private compiled broker environment in `runtime/src/compiled-broker.ts`, the contained test environment in `runtime/test/support/contained-environment.ts`, and the redirected profiles in `runtime/test/process.test.ts`. `runtime/test/startup-helper-scratch.test.ts` and `runtime/test/private-artifact-contract.test.ts` assert the PATH opt-out in the environments they build. Both example folders above came from untracked scripts this change cannot reach. The `startup-target-30` entry matches `.tmp/startup-target-30/build-native-probe.ps1`, which points `DOTNET_CLI_HOME` at that folder's `dotnet-home`, sets `DOTNET_SKIP_FIRST_TIME_EXPERIENCE` but not the PATH opt-out, and runs `dotnet build`; its sibling `run-native-benchmark.ps1` points `DOTNET_CLI_HOME` there too but only runs the built executable through `node`, without the SDK. The `pv17-6d82` entry came from a probe run in a prototype worktree that was deleted on 2026-10-20.

## Follow-up

Confirm the attribution with a check that a redirected-home run leaves the User PATH unchanged, and keep untracked probe and harness scripts that redirect `DOTNET_CLI_HOME` or the profile on the same opt-outs. Agents do not edit the persisted PATH.

## Status

Tracked at the user request on 2026-10-19, during follow-up triage of FeatherPod Nightshift run bb4c3033. Partly fixed on 2026-10-20 as described above; open until the PATH check passes. A read-only check later on 2026-10-20 found the User PATH at 1,275 characters over 31 entries, none under this repository's `.tmp`, so the stale entries had been removed by then.
