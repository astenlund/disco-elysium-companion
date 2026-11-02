# Named resume durable binding

Raised during Nightshift run b6bd3335-9981-4976-a7b5-4764868a8b35 on 2026-11-02 and tracked by the user in triage. The defect predates that run, which did not change it.

## Recorded evidence

During a named resume, `ProviderLifecycle.establish` in `runtime/src/provider-lifecycle.ts` writes the named session's durable binding through `backend.sessions.bind`, whose `SessionStore.bindOwned` in `runtime/src/session-store.ts` writes `agent-session.json` before its second proof check and the session index write. After `bind` returns, `establish` runs its last checks: an epoch check, a second `verifyLive`, another epoch check and the current-instance check. Any failure of the named start sends `ProviderLifecycle.resume` to its catch, which runs `endCurrent()`, then `requireEpoch`, then tries to re-establish the previous binding through `establish` again. The defect window opens once the named start's `agent-session.json` write has landed and a later step, inside `bind` or after it, fails.

The last `agent-session.json` write that landed decides which session the file names:
- A restore whose own `bind` write lands names the previous session again, even if a later step of the restore fails and leaves the provider failed.
- When no restore write lands, the file keeps what the named start left: the failed session if its write landed, the previous one if it did not. The restore write does not land when there was no previous binding, when the catch's own `endCurrent()` throws (the failed session's close or termination proof failing again), when `requireEpoch` refuses (an epoch change, an incompatible exit, a closed lifecycle or a lost guard), or when the restore fails before its own write lands. That is the complete set in the current catch.

The governing design, the named-resume admission paragraph in `.nightshift/features/companion-execution-runtime.md`, says a provider failure on an admitted named resume "keeps the current binding". The startup resume reads `agent-session.json` only, so the next start tries the failed session rather than the earlier one. With a previous binding this needs the named start to fail after its write landed and the restore write not to land; with none, a named-start failure after its write landed suffices. A review reported that a named resume with no previous binding is reachable after a retryable initial safety refusal; that path was not traced when this record was written. How often any of these cases happens in practice is unknown, and no live reproduction was run.

## Follow-up

Decide which binding a failed named resume should leave durable (the previous binding, or none when there was none), then make the failure paths restore it or defer the write until every step after it passes, keeping the index write discipline the design states. Add a regression test for a path that reproduces the defect, such as a named start that fails after its `agent-session.json` write followed by a restore that fails before its own write.

## Status

Open. No fix is authorized by this entry.
