---
status: exploring
---

# Baldur's Gate 3 adapter

Add Baldur's Gate 3 as the companion's second game, with a full save-reading
adapter (parity ambition with the Disco Elysium adapter) and a new
rules-knowledge layer: embeddings over the Dungeons & Dragons 5th Edition
(2014) ruleset that ground mechanical guidance in the actual rules text.

Captured 2026-08-15 from a user idea. Confirmed at capture time: full
save-reading depth is the goal (not a rules-only companion), the default rules
source is the SRD 5.1, with an optional user-supplied owned full rulebook, and
there is no timeline (someday, no planned playthrough). Everything else is
provisional.

## State extraction

BG3 saves are Larian's package format: `.lsv` save packages containing LSF
binary resources, a substantially bigger parsing lift than Disco Elysium's
save format. Norbyte's open-source LSLib handles the format and is the obvious
foundation; it is a .NET library, which suits the PowerShell core. Open
questions live below; the working assumption is that the adapter follows the
schema-v2 contract (`.claude/specs/state-extraction.md`) so the acquisition
pipeline, digest admission, and diff machinery are reused rather than forked.

BG3's state space is far larger than Disco Elysium's (party of four plus
companions, inventories, spell slots, class resources, quest flags across
three acts, dice-roll checks everywhere). Deciding what the digest projects,
and what stays unextracted, is a core design task, not an afterthought.

## Rules-knowledge layer (embeddings)

New infrastructure: nothing in the companion today has an embeddings or RAG
layer. The idea is to embed the D&D 5e (2014) rules so guidance about builds,
checks, spells, and mechanics cites real rules text instead of model memory.

Two-tier source model, confirmed at capture time and driven by the intent to
eventually make the project public:

- **SRD 5.1 as the shipped default.** Freely licensed under CC-BY-4.0, so it
  can live in a public repo with attribution. It covers the core 2014 rules
  but omits most subclasses, many feats, and some spells.
- **Owned-rulebook overlay.** A user who owns digital copies of the 2014 core
  books can point the companion at them; their embeddings are built and kept
  strictly locally, never committed or distributed. The overlay fills SRD
  gaps; the companion should degrade gracefully to SRD-only coverage.

BG3 also diverges from tabletop 5e in known ways (ruleset tweaks, homebrew
actions, removed reactions). The layer needs a story for where BG3-specific
rule deltas live relative to the embedded tabletop text.

## Family relationships

- The [companion execution runtime](companion-execution-runtime.md) reserves an
  "Adapter catalog and session isolation" slice that a second adapter would
  exercise for real: per-adapter agent sessions, journals, persistence, and
  preferences. BG3 is the concrete test case that generalization has been
  waiting for.
- The [adaptive guidance knowledge](adaptive-guidance-knowledge.md) draft
  defers a "Generic research-adapter contract" until a first adapter supplies
  implementation evidence; a BG3 adapter is the consumer that validates or
  reshapes that contract. Its evidence core is also a candidate home for
  rules-citation claims with provenance.
- The DE adapter's `adapters/disco_elysium/` layout (releases, knowledge.md,
  adapter config) is the structural template for `adapters/baldurs_gate_3/`.

## Open design questions

- LSLib integration shape: invoke LSLib assemblies from PowerShell directly,
  wrap a small .NET extraction tool, or shell out to a converter binary; and
  how adapter releases pin the LSLib version.
- Digest scope: which BG3 state the digest projects first (party vitals,
  active quests, inventory, camp resources?) and what parity with the DE
  digest schema even means for a party-based game.
- Embedding infrastructure: local embedding model versus API, storage format,
  and where the index lives (per-adapter directory versus shared core
  service other adapters could reuse).
- Retrieval boundary: how rules citations enter answers under the guidance
  rules; whether retrieved rules text is spoiler-safe by construction (rules
  are, quest content is not) and how the spoiler discipline translates to
  BG3's quest and companion content at all.
- SRD licensing hygiene: CC-BY-4.0 attribution placement if SRD-derived text
  or embeddings ship in the public repo, versus building the index locally on
  first run from a fetched SRD copy.
- Owned-content isolation: the mechanism that guarantees user-supplied
  rulebook content and its derived embeddings never leave the machine
  (gitignore boundaries, storage location outside the repo, or both).
- BG3-versus-tabletop rule deltas: curated delta notes, a separate embedded
  corpus, or adapter knowledge.md prose.
