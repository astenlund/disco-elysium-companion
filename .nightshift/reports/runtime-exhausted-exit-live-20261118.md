# Chat exit after helper exhaustion, live check

Recorded on 2026-11-18 for the bug "Provider outlives a failed shutdown after helper exhaustion" (see [bug history](../BUGS_HISTORY.md)), in Nightshift run 3765cdf2-b11c-4178-8e84-4c235911bd07. The question was whether a provider keeps running when chat exits after its shutdown failed because the native helper was exhausted, since the synthetic provider in `runtime/test/client/chat-helper-lifecycle.test.ts` stays alive for as long as the test process does.

## Setup

Every run used a private fixture root under the repository's `.tmp`, made by `runtime/test/fixtures/companion-root.ps1 -RuntimeOwned` with its provider configuration replaced by the real models (`claude-sonnet-5-5`, override `claude-opus-5-5`) and the watcher disabled. No run touched the real data root or the game's save folder. A supervising PowerShell driver started the fixture host and the chat process, recorded the chat process's descendants with their creation times, killed the helper service and then its replacement through `Stop-Process`, and checked each recorded descendant by process id and creation time 10 seconds after the chat process ended. The scripts stayed in this run's ignored scratch folder.

## Result

The deciding run went through the real `chat` command entry, `runCli(['chat'], <fixture root>)`, with the CLI's own text client and the real Claude provider:

- The client attached about 12 seconds after launch and printed `provider: ready` with `safety: recovering` (the owned fixture's `contextUncertain` correction). The chat process's descendants were the helper service, the provider broker (`companion-helper.exe broker`), `claude.exe` from `@anthropic-ai/claude-agent-sdk-win32-x64` and their console hosts.
- After both services were killed and no service was left, `/quit` printed `Client error: Process-tree termination is unverified: Native process metadata is unavailable.` and then `nativeHelperUnavailable (unavailable): ... Restart the runtime.`, and the chat process exited with code 1 within a second.
- Ten seconds later none of the recorded descendants, `claude.exe` included, was still running, and the fixture host then removed the root and exited with 0.

An earlier run through `createChatRuntime` and `runChatClient`, without the text client, gave the same outcome: shutdown rejected with `nativeHelperUnavailable (unavailable)`, exit code 1, no survivor. A first attempt of that probe created the fixture inside the chat process itself; it then did not exit, held open only by the fixture host it had started, which the real CLI never starts, so that attempt says nothing about chat.

## Conclusion

A real provider does not outlive a chat exit after a failed shutdown on an exhausted helper: the chat process ends on its own, and its provider ends with it. No production change is needed. The automated regression `ends the chat process and its provider when chat exits after a shutdown the exhausted helper failed` in `runtime/test/client/chat-helper-lifecycle.test.ts` pins the same behavior with the synthetic provider in a separate chat process (`runtime/test/support/exhaust-and-exit.ts`).

## Limits

One live run of each probe, on one machine (LUMINOS), with the real provider idle at the exit (no turn in flight). The check observed the processes ending; it did not establish which mechanism ended `claude.exe` (its input closing or its broker's kill-on-close job), and it did not cover a provider in the middle of a turn.
