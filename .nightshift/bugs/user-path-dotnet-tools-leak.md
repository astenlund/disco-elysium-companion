# .NET tools folders leak into the User PATH

## Recorded observation

On 2026-10-19, in a session working on another project (FeatherPod), a repository pre-commit hook's `npx eslint` failed with "not recognized" because the inherited PATH was longer than cmd's 8191-character limit, beyond which cmd treats PATH as empty. The persisted User-scope PATH was 10,267 characters over 109 entries. 71 of those entries (about 8,715 characters) were `.dotnet\tools` folders under this repository's `.tmp`, such as `C:\Git\disco-elysium-companion\.tmp\startup-target-30\dotnet-home\.dotnet\tools` and `C:\Git\disco-elysium-companion\.tmp\pv17-6d82\.tmp\proof-6d82\run-first-20261018-6d82\a\dotnet-home\.dotnet\tools`, and none of those folders existed any more. Some folder names carry the date 20261018, so the entries are still accumulating, and every new session on the machine inherits the bloated PATH.

## Hypothesis (unverified)

Test or probe runs here point `DOTNET_CLI_HOME` at a fresh `.tmp` folder, and the .NET SDK's first-run step then adds that folder's `.dotnet\tools` directory to the User PATH. Setting `DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false` for such runs is believed to suppress this; that comes from memory and was not checked. The project memory note `memory/projects/dotnet-first-run-probe.md` records a related first-run side effect of a `DOTNET_CLI_HOME` redirect (a reported HTTPS development certificate install).

## Follow-up

Confirm which runs add the entries and stop them from changing persisted host environment state, with a check that a run leaves the User PATH unchanged. Removing the existing stale entries is the user's task; agents do not edit the persisted PATH.

## Status

Tracked at the user request on 2026-10-19, during follow-up triage of FeatherPod Nightshift run bb4c3033. No fix was authorized by that decision.
