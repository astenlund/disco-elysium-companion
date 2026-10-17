# Early input lost during verified attachment

Deferred from the private healthy-startup implementation review on 2026-10-17. The change has not been published.

## Recorded evidence

`runTextClient` creates its readline interface before awaiting `SessionHost.attachVerified`, but registers the line listener after attachment and the greeting. A line typed during that asynchronous proof is emitted without a listener and lost. This changes no durable state and sends no provider input. The reviewer classified the user experience gap as minor; no live reproduction was run.

## Follow-up

Admit or buffer early text only after the verified client is ready, and test input arriving during a deferred attachment. Preserve the rule that the runtime never automatically resends a question.

## Status

Deferred under the user's minor-finding instruction. No fix or publication is authorized by this entry.
