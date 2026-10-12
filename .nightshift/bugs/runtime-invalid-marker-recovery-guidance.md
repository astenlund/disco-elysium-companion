# Invalid runtime marker recovery

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Resumed Fable spec review ed5cc2d4 and fresh Astra skepticism 65bd79cb confirmed that readable but content-invalid runtime.json causes all mutating commands to fail before watcher reconciliation or marker publication. With quiescent jobs, the CLI renders dataRootUnavailable and status reports runtime metadata invalid. The behavior is fail closed, but the design's general recovery-path sentence gives no runtime-marker-specific operator remedy. A valid restored marker may pass parsing; deletion is not established as the sole or safe repair.

## Proposed follow-up

Define operator-assisted recovery guidance for content-invalid runtime metadata, distinct from absent or unreadable metadata and invalid scope binding. Preserve scope and durable delivery/safety records, prove predecessor quiescence, and keep backups non-authoritative.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
