# Source-domain identifier recipe

Tracked after the dark coordinator MVP in Nightshift run cffcf94d-49be-4cab-afcb-3fad1dabfd95.

The evidence below is the original finding. Time-dependent wording refers to its review snapshot and must be checked against current files before a fix.

## Recorded evidence

Noticed by a skeptic on 2026-10-06 and verified: state extraction (the source.domainId lifecycle paragraph, around line 450) says the acquisition-domain identifier is a SHA-256 over a length-prefixed UTF-8 tuple with the literal tag companion-source-domain-v2, the adapter directory's normalized full path, the saveDirectory's normalized full path, and the saveGlob, with 32-bit big-endian lengths. The shipped core (core/private/AdapterConfig.ps1, the SourceDomainId assignment) hashes only the full save directory, a NUL character, and the glob, with no tag, no adapter directory, and no length framing. The mismatch is pre-existing and outside the coordinator MVP. Every existing digest and baseline carries identifiers computed by the code's recipe, so changing the code would change every domain identifier and force one baseline reset on every install.

## Proposed follow-up

Track it as a bug: decide which side is authoritative. Aligning the spec to the code is free; aligning the code to the spec costs one disclosed reset per install and should ride a version bump.

## Status

The user chose to track this item on 2026-10-12. No fix, publication, or real-root cutover was authorized by that choice.
