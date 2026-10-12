---
status: exploring
---

# Source-domain change reset policy

This is a deferred design question from Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95. The user chose to track it after the dark coordinator MVP.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before design work.

## Recorded evidence and uncertainty

Raised by the skeptic validating the deferred-fence finding on 2026-10-06 and confirmed against the agreed coordinator design: a source-domain change (the configured saveDirectory or saveGlob edited, the path respelled, or the companion root or adapter directory moved, all without a version bump) is not a runtime reset point. The runtime's drain compares principal and game, and its versionChange cause compares only schemaVersion and adapterVersion, so a pending record committed under the old domain is appended, settled in structural mode, and delivered; the next ordinary publish then finds the old-domain baseline content-invalid and commits a consumed record with baselineReset: true, so the session sees one old-domain diff, then a reset disclosure, then the new-domain state. The bridge, by contrast, refuses to inject an envelope whose source domain differs from a fresh configuration (state extraction section 7.5). The agreed design states this as a residual and ships it dark. Making a domain change a reset point would quarantine the old-domain events behind a resync, which discards real undelivered changes after a mere path respelling, because the domain identity is deliberately conservative.

## Direction to investigate

Track it as a feature question for after the MVP: decide whether a source-domain change should be a runtime reset point like a version change (the runtime would compare the source domain of each unacknowledged event's state with a receipt target's), weighing one possibly stale diff after a real selector change against discarded true changes after a respelling.

This draft does not authorize implementation, publication, a real consumer switch, or changes under SaveGames.
