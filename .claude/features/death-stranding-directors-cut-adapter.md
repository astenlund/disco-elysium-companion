---
status: exploring
---

# Death Stranding Director's Cut adapter

Add Death Stranding Director's Cut on PC as a state-aware logistics companion.
The game is a strong product match for the companion because useful guidance
depends on current orders, carried cargo, equipment, capacity, destination,
facility progress, and recent unlocks. The principal uncertainty is technical:
the local `checkpoint.dat` format needs a proven semantic reader before a full
adapter can be designed responsibly.

Captured 2026-08-18 from a feasibility discussion. The product direction and
read-only feasibility gate are settled at capture time. Save internals, digest
projection, storefront coverage, and delivery scope remain provisional.

## Product fit

Death Stranding repeatedly asks the player to prepare rather than merely choose
dialogue: combine compatible orders, balance required cargo against useful
equipment, account for delivery constraints, and decide where scarce materials
or structures matter. Official guidance emphasizes cargo weight, route planning,
equipment selection, vehicles, rest stops, and cargo condition, which are all
better answered from current state than from a generic walkthrough:

- [Kojima Productions: Connecting the Eastern Region](https://kojimaproductions.jp/en/DSTips)
- [505 Games: Director's Cut beginner's guide](https://deathstrandingpc.505games.com/en/death-stranding-directors-cut-beginners-guide/)

The spoiler boundary is also natural. The companion can improve preparation and
priority without revealing narrative outcomes, unseen orders, future equipment,
or undiscovered locations. Advice should remain directional unless the player
explicitly requests broader spoilers.

## State-extraction feasibility gate

The PC release keeps multiple local saves, but each slot centers on an opaque
binary `checkpoint.dat`. The public Decima tools found during capture advertise
game-resource, core-object, and archive support rather than semantic checkpoint
parsing. That absence is a research finding, not proof that no suitable parser
exists:

- [Official Director's Cut PC FAQ](https://deathstrandingpc.505games.com/en/death-stranding-directors-cut-pc-community-faq-guide/)
- [Decima Workshop](https://github.com/ShadelessFox/decima-workshop)
- [DecimaTools](https://github.com/Wunkolo/DecimaTools)

Before dependency analysis or adapter design, run a read-only spike against
player-owned saves. Use controlled save pairs in which one observable value
changes at a time, operate only on repository-local copies, and never modify the
live save tree. The spike must:

- identify the checkpoint container, compression, encryption, checksum, and
  account-binding layers sufficiently to read without patching the game;
- demonstrate stable extraction of location, active orders, carried cargo,
  owned equipment, progression or unlock state, and facility status;
- distinguish locally authoritative state from online or session-ephemeral state;
- detect incompatible game or save versions and fail closed rather than emitting
  a partial digest; and
- estimate how much game-data catalog extraction is required to turn internal ids
  into spoiler-safe player-facing labels and mechanics.

Failure to extract every candidate field does not automatically reject the
adapter. Failure to extract enough state for a materially better porter brief
than manual questioning does.

## Candidate MVP: porter brief

The first useful slice should answer what the player is prepared to do now, not
attempt to solve the whole map. Candidate state includes:

- current location and broad progression context;
- active accepted orders, destinations, carried order cargo, and known delivery
  constraints;
- optional cargo, equipment, current load, capacity, and key condition values;
- relevant facility connection levels and locally stored resources, if the save
  represents them reliably; and
- newly completed or accepted orders, cargo changes, equipment unlocks, and
  facility-progress changes since the previous consumed save.

Guidance can then flag preparation gaps, identify compatible accepted orders that
may be batched, distinguish meaningful progress from routine deliveries, and
recommend equipment already available to the player. It must not infer live route
safety from stale or absent world state.

The MVP excludes automatic terrain routing, a live map overlay, complete online
structure tracking, ranked-event scheduling, memory hooks, executable patching,
and all save writes. Those capabilities need separate evidence and design.

## Architecture relationships

- The [companion execution runtime](companion-execution-runtime.md) must isolate
  state, events, preferences, and agent sessions by adapter and playthrough before
  a second game becomes a normal runtime concern.
- [Adaptive guidance knowledge](adaptive-guidance-knowledge.md) needs an
  adapter-owned research and disclosure projection for order constraints,
  equipment mechanics, facilities, and spoiler-safe progression labels.
- The current schema-v2 digest has several Disco Elysium-shaped required fields.
  Death Stranding should not force porter grades, chiral bandwidth, facility
  materials, cargo condition, or vehicle state into misleading generic fields.
  The design must decide which concepts are genuinely shared and which belong in
  a typed adapter projection rather than treating `extra` as an unstructured
  escape hatch.
- The [Baldur's Gate 3 adapter](baldurs-gate-3-adapter.md) remains the safer
  candidate second adapter because LSLib reduces format risk. Death Stranding may
  be the stronger moment-to-moment companion product if the checkpoint spike
  succeeds, so implementation order should follow evidence rather than the order
  in which ideas were captured.

## Open design questions

- Which PC storefront and save-layout variants should the first adapter support?
- What semantic structure, version markers, integrity checks, and account binding
  exist inside Director's Cut checkpoints?
- Which order, cargo, facility, structure, vehicle, and map facts are authoritative
  in the local save, and which depend on the live Social Strand session?
- What is the smallest digest projection that produces a useful porter brief while
  keeping the core schema honest across games?
- Can internal order and location identifiers be labeled without loading text that
  reveals unseen objectives or narrative outcomes?
- Does the game save often enough at decision boundaries for consumed diffs to feel
  current, or will the companion need an explicit save-before-guidance convention?
