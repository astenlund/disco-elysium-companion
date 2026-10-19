# Selected path requires canonical launch spelling

Found by the independent code review of the private startup branch on 2026-10-19 and deferred at the user's direction while the compiled selector is off.

## Recorded evidence

Node keeps the path case as typed when it builds `import.meta.url` for the main entry, so `cli.ts` derives `companionRoot` and the image root in that case. `BootstrapImagePins.ps1` requires each request root to match the canonical admitted spelling ordinally. A reviewer probe at `.tmp/cc-eefa8669/review-code/probe-main-url.mjs`, run through a lowercase path, reported the root in the typed case. With the selector enabled, `node c:\git\...\runtime\src\cli.ts chat` would therefore fail with `helperFailed` after the transfer mark, leaving the pin obligation unknown, and exit 1 with only the generic refusal; it neither canonicalizes nor falls back. Ordinary chat is unaffected.

## Follow-up

Derive the selected request's roots from the canonical admitted spelling, for example through the native final-path form, without changing the ordinary path's scope identity, and decide how a junction or substituted-drive launch should be treated. Cover a lowercase and a junction launch in the private copied-root fixtures.

## Status

Tracked as a selector acceptance gate. No fix or publication is authorized by this entry.
