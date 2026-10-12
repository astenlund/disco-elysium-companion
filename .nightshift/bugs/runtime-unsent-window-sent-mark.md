# Sent mark after unsent refusal

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Fresh whole-spec Fable reviewer aee5467b and independent Astra skeptic f34d450d confirm a minor, required:false sent-mark lifecycle difference. A window episode refused at candidate selection occurs before markSent and leaves the mark unchanged. A later equivalent failed disclosure can be refused inside beforeSend after markSent has already raised the prepared event prefix's process-local and possibly durable sent mark, even though no provider input followed. A later actual send may label those never-sent events redelivery:true and emit stateRedelivered; the refused turn itself emits no such notice and acknowledges nothing. This is within the accepted conservative duplicate-show side, not event loss or unsafe acknowledgement. Existing tests do not assert this exact late-refusal/durable-mark combination.

## Proposed follow-up

Track a narrow contract clarification and focused boundary fixture: retain the mark on refusal after marking, leave it unchanged on selection-time refusal, and emit redelivery notice only on a later actual send. Preserve sent/ack ordering, failed-publication restart behavior and no automatic resend.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
