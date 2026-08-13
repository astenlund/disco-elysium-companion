# Playthrough guidance research cache

> SPOILER WARNING
>
> This file contains quest timing, availability conditions, check details, and
> route-planning research for the current playthrough. It is written for the
> companion, not for spoiler-safe browsing by the player. Stop at the second
> warning below unless you deliberately want to inspect that material.

Temporary evidence cache for spoiler-safe guidance until the adaptive guidance
knowledge feature is implemented. This file is scoped to the current Disco
Elysium playthrough and is not authoritative game state.

## Freshness

- Researched on: 2026-08-09
- Save file: `QuickSave(8_9_2026 3-54-42 AM).ntwtf.zip`
- Save timestamp UTC: `2026-08-09T01:54:42.4747299Z`
- Digest adapter version: 2
- In-game position: Day 4, 16:12, `Martinaise-ext`
- Baseline note: the consuming diff reset after the adapter upgraded to version
  2. A two-save walkback recovered the last eventful span, from Day 4 08:09 to
  08:19, with no objective changes.
- Latest consumed diff: the church and Soona task cluster opened; Identify Corpse
  Boardwalk advanced to Go to Billie's Apartment; the armour-number thread advanced;
  `shirt_polo`, `drug_alcohol_potent_pilsner`, `shoes_snakeskin_red`, and
  `kvalsund_multitool` were acquired; `hat_bum` was lost; Actual Art Degree became
  known; Remote Viewer finished internalizing; the player now has five unspent skill
  points and 59.45 real.

Always run the `AGENTS.md` state-before-answers procedure before consulting this
file. A newer save, adapter-version change, or current-state conflict makes the
corresponding snapshot details stale. Current state wins.

## Player guidance preferences

- Optimize for an enjoyable, completionist-friendly playthrough rather than
  automatically prioritizing the critical path.
- Prioritize meaningful side content, missable conversations, white-check
  opportunities, delayed follow-ups, and expiry or progression-cutoff risks.
- Keep advice directional and avoid revealing unseen tasks, outcomes, dialogue,
  or mystery answers.
- Give an immediate calibrated answer when possible. A quick search is
  appropriate for unfamiliar material; deeper requested research may continue
  separately.
- For any action involving a white or red check, recommend the strongest owned
  clothing and held-item combination, including exact swaps and the net effect.

## Safe maintenance notes

Creation and scope:

- This file was created from the current save plus a bounded online research
  pass. It belongs only to this playthrough.

Refresh:

- After the mandatory state refresh and consuming diff, compare the current
  save timestamp, adapter version, active objectives, inventory prerequisites,
  skills, thoughts, and white-check counts with this file.
- Update the freshness header and affected findings after material progress, a
  new task or check, a completed or removed task, a user question that reveals a
  new preference, or new research that changes confidence.
- When a newly acquired item appears, reevaluate every recorded active,
  retryable, or seen check that it could affect through a skill bonus, penalty,
  required tool, dress code, or check-specific modifier.
- When a new check appears, evaluate its optimal loadout against the entire
  owned inventory and current equipped state, then add it to the snapshot.
- When `extra.thoughts.known` gains a thought, add a spoiler-filtered alert
  record during the same response. It must include research time, temporary and
  permanent mechanics, known slot or skill-point cost, current-build assessment,
  confidence, reconsideration triggers, and exactly one recommendation:
  internalize now, hold for later, or not a current priority.
- Persist changed loadouts during the same maintenance pass. If item or check
  modifier evidence is incomplete, mark the result provisional and queue hidden
  research rather than guessing.
- Preserve durable source-backed findings that remain applicable. Remove tasks
  from the current-priority sections when state shows them completed, but retain
  reusable claims if they still explain another active item.

Invalidation:

- Never use a stale snapshot detail to contradict `state/current.json` or the
  consumed diff.
- On adapter-version changes, revalidate every field interpretation before
  trusting it.
- On a reload rewind, reconcile against the rewound state rather than treating
  removed progress as completion.
- If a source becomes unavailable or conflicts with stronger evidence, lower
  the claim's confidence and record the dispute rather than silently replacing
  it.

Consumers:

- Companion guidance sessions read this file after fresh state.
- Research updates write back to this file after the answer or research pass so
  the current response is not delayed merely to maintain the cache.
- The future adaptive guidance knowledge feature replaces this file. Delete the
  temporary cache and its `AGENTS.md` read rule when that feature ships.

## Detailed playthrough research begins below

> SPOILER WARNING: STOP HERE FOR SPOILER-SAFE READING
>
> Everything below may expose known quest names, time windows, availability
> conditions, inventory implications, check difficulties, and route structure.
> The companion must filter it through the project spoiler rules before showing
> any of it to the player.

## Current horizon

The player is on Day 4 at 16:12 with Kim present, 4 health, 3 morale, 59.45
real, and five unspent skill points. The high-value current clusters are:

- **Whirling and Kineema follow-ups:** Run Serial Number, Doorgunner Megamix,
  Question Klaasje Victim, Decipher Victim's Tattoo, Hear What Sunday Night,
  and Pissing Competition.
- **Harbour and nearby conversations:** Talk Merc Tattoo, Who Put the Clothes
  in the Trash, and Ask Boy About Armour.
- **Coast circuit:** Inspect Traps, Take Bird to Garte, Identify Corpse
  Boardwalk, Investigate Mysterious Door, and Deliver Mail to Fishing Village.
- **Church and Soona:** Establish Church Dance Club, Help Soona with Her Project,
  Egg Head Puzzle, Sync the Sines, and their already-known subtasks.
- **Expressive and optional errands:** Add Even More Beauty to the Wall, What
  Is Race Enigma, Buy FALN Pants from Cuno, and Become Man of Plenty.
- **Open case thread:** Find Murder Weapon.

Inventory makes several follow-ups immediately actionable: the player owns the
boombox and mercenary tape, the tattoo photograph, Cindy's brush and the fuel
canister, a white envelope carrying Lilienne's signature, and the ruffed grouse
taxidermy item for the active hand-in. The Kvalsund multitool removes the prybar's
prohibitive ice-cream-maker penalty and makes Help Soona with Her Project the strongest
immediate side-content route. The owned Mega-Bino's Prescription
Lenses provide +2 Encyclopedia and -1 Perception; reserve them for Encyclopedia
checks rather than exploration because Perception controls discoverable world
interactions.

## Thought discovery alerts

### Actual Art Degree

- Delta evidence: `extra.thoughts.known` gained `art_cop` on Day 4 between 10:35
  and 16:12.
- Research: 1h 30m. It applies -1 Perception while researching.
- Permanent mechanics: -1 Hand/Eye Coordination; successful Conceptualization
  passives heal +1 Morale and award +10 XP.
- Current assessment and recommendation: internalize now, using the next free cabinet
  slot. Conceptualization 5 should trigger the reward often, Perception 8 can absorb the
  temporary penalty, and the player has substantial side content remaining. The lasting
  Hand/Eye Coordination reduction is meaningful because the raw skill is only 2, but
  the XP and morale engine is unusually strong for this completionist route.
- Reconsider only if a desired Hand/Eye Coordination check is immediately pending or a
  cabinet slot would require forgetting a more valuable internalized thought.
- Confidence: high. Mechanics are corroborated by the primary thought page and current
  state.

### Wompty-Dompty Dom Centre

- Delta evidence: `extra.thoughts.known` gained `trant_heidelstam` on Day 4 at
  09:58.
- Research: 0h 42m. It applies -1 Suggestion while researching.
- Permanent mechanics: successful Encyclopedia passives award +10 XP and +2.00
  real; the completed thought applies -2 Suggestion.
- Current assessment: hold for later. The player has Suggestion 4, two active
  Suggestion white checks, 3 unspent skill points, and 51.23 real. The passive
  reward is attractive for a completionist run, but the lasting Suggestion loss
  is an immediate drawback while those known checks remain desirable.
- Reconsider when the player has resolved or deprioritized the known Suggestion
  checks, gains a reliable compensating modifier, or deliberately prefers the
  long-term Encyclopedia reward over social-check flexibility.
- Confidence: high. The mechanics are corroborated by the primary thought page
  and current state.

## Evidence-backed guidance

### Do soon

- **Help Soona with Her Project:** equip the Kvalsund multitool, wear the Physical
  Instrument tank top and any gloves, and unplug the machine before attempting the
  ice-cream-maker white check. Try once before investing a skill point. This is the
  strongest current meaningful-side-content route. Confidence: high.
- **Go to Billie's Apartment:** meaningful narrative follow-through from Identify Corpse
  Boardwalk. Do it after the current church attempt or when a change of tone is welcome.
  No hard clock expiry was found. Confidence: high.

- **Hear What Sunday Night:** meaningful side content with a genuine
  availability condition. Use the first natural opportunity when Kim is absent
  and complete it before substantially advancing the central investigation.
  Confidence: high.
- **Talk Merc Tattoo:** meaningful optional content tied to a character whose
  availability changes after later case progression. The required photograph is
  already owned. Confidence: high.
- **Doorgunner Megamix, Question Klaasje Victim, and Decipher Victim's Tattoo:**
  handle as one Whirling circuit. Listen to the owned tape, then exhaust the
  related conversations with already-known participants. Confidence: high.
- **Run Serial Number:** the task has advanced to its personal-information follow-up.
  The journal clock denotes delayed progression, not a countdown visible in the save.
  Let it mature unless the journal supplies a concrete action. Confidence: medium-high.

### Meaningful side-content priority

- **Deliver Mail to Fishing Village:** the signed-envelope state indicates that
  the choice is still in progress. Inspect the envelope and choose deliberately
  how to finish it before mailing, because mailing commits the selected route.
  Confidence: high.
- **Add Even More Beauty to the Wall:** the brush and fuel are already owned, so
  the task is ready to finish. Meaningful expressive side content. Confidence:
  high.
- **Pissing Competition:** ask Kim after the completed body inspection. Quick
  flavor and experience, classified as busywork because it has little remaining
  friction or consequence. Confidence: high.

### Progression boundary

The main risk is progression-triggered rather than ordinary clock passage. The
player has not yet reached the later, telegraphed cutoff. Before following a
central lead into an obviously isolated or confrontational sequence, finish the
coast and cryptozoology material, harbour business, and desired conversations
with currently known case participants. Do not reveal the unseen task or event
that implements this boundary. Confidence: high.

One calendar-based NPC change occurs soon, but no currently active objective
requires a special detour for it. Keep this fact directional and do not reveal
the character or outcome unless the player has already observed the change.
Confidence: high.

## White-check snapshot

The save reports four retryable and five seen-only white checks. The journal map is known to
retain obsolete entries, so the holder and map are reminders rather than a
perfect action list.

| Check | Skill | Difficulty | Guidance |
|---|---:|---:|---|
| Sleeping Dockworker | Physical Instrument | 12 | Available now. Improve the raw skill with the owned tank top. |
| Man from Hjelmdall Series | Pain Threshold | 10 | Available now. No owned Pain Threshold clothing, but the Rummager dress code helps this specific check. |
| Mirror | Interfacing | 12 | Available now. Strong owned tool, clothing, and dress-code combination exists. |
| Box of Sunglasses | Conceptualization | 13 | Best eventual retry candidate. Collect clothing modifiers before spending a point. |
| Washerwoman | Suggestion | 14 | Relevant only if the player wants this route for the envelope. Alternatives exist, so do not force a point investment. |
| Ice Cream Maker | Physical Instrument | 15 | Attempt now with the Kvalsund, tank top, gloves, and machine-unplugged modifier before spending a point. |
| Barred Door | Physical Instrument | 15 | Poor investment at Physical Instrument 3. Leave for later. |
| Warded Door | Pain Threshold | 12 | Attached to content already resolved by another route; low priority. |
| Trash Container | Physical Instrument | 14 | Stale because the container was already opened by another route. Ignore. |
| Lilienne, the Net Picker | Suggestion | 15 | Optional and currently difficult. Explore the coast and gather modifiers first. |

Keep both unspent skill points available until a desired check presents a clear
reason to invest. Recompute this section when skills, thoughts, relevant
inventory, or failed-check caches change materially.

## Current check loadouts

Resolver order:

1. Equip every required held tool or item.
2. Activate owned check-specific dress codes and situational modifiers.
3. Maximize the tested skill in all remaining slots without breaking the first
   two conditions.
4. Treat drugs and alcohol as an optional final layer only after stating their
   health or morale cost.

For conflicting item data, prefer the live engine modifier map for equipped
items, then corroborated clothing metadata for unequipped owned items. The raw
save text for the Korojev jacket is stale: the live engine and current clothing
reference both give it +1 Logic, not +1 Conceptualization.

The newly acquired `glasses_megabinos` do not change any recorded active,
retryable, or seen-check loadout because none currently tests Encyclopedia or
Perception. They are the strongest owned Encyclopedia glasses at +2, but their
-1 Perception penalty makes them an explicit check-time swap, not exploration
gear. Reevaluate this conclusion when an Encyclopedia or Perception check is
discovered.

| Check | Best currently owned setup | Supported effect |
|---|---|---|
| Sleeping Dockworker | Swap the mesh shirt for `shirt_tank_top`; other slots are neutral for this check. | +1 Physical Instrument. |
| Man from Hjelmdall Series | No owned clothing raises Pain Threshold. The lost `hat_bum` means the former Rummager combination is unavailable. | No current owned skill or dress-code bonus. |
| Mirror | Hold `chaincutters`, wear `shirt_tank_top` with no jacket, and keep `gloves_garden`. | +1 Interfacing and a check-specific difficulty reduction of 2; chaincutters satisfy the tool requirement. |
| Box of Sunglasses | Wear `shirt_dress_disco`; other owned slots are neutral for Conceptualization. The lost `hat_bum` removes the former Rummager combination. | +1 Conceptualization. |
| Washerwoman | Wear `shirt_interisolar`, the owned Interisolary suit jacket, and `pants_interisolar`. The trousers are already equipped. | +1 Suggestion from the jacket and a check-specific Interisolar business class reduction of 1. |
| Ice Cream Maker | Hold `kvalsund_multitool`, swap `shirt_mesh` for `shirt_tank_top`, keep `gloves_garden`, and unplug the machine before rolling. | +1 Physical Instrument, +1 gloves modifier, +2 machine-unplugged modifier, and no prybar penalty. |
| Barred Door | Wear `shirt_tank_top`; other owned clothing is neutral for Physical Instrument. | +1 Physical Instrument. No owned check-specific bonus is available. |
| Warded Door | No owned clothing raises Pain Threshold. Do not change gear solely for the raw skill. | Only non-inventory situational modifiers can currently help. |
| Trash Container | Ignore the stale entry; the container was already opened by another route. | No loadout maintenance needed. |
| Lilienne, the Net Picker | Wear the owned Interisolary suit jacket, `neck_bowtie`, `shirt_interisolar`, and `pants_interisolar`; avoid Suggestion-penalty clothing. | +1 Suggestion and a check-specific Man of Charms reduction of 2. Explore the coast before attempting it. |

These are snapshot loadouts, not timeless recommendations. Recompute them after
inventory, equipped items, thoughts, skills, check modifiers, or party state
changes. For a red check, present the loadout before the one-shot attempt. For a
white check, also identify whether a skill point would reopen a failed attempt.

## Sources

Task references:

- https://discoelysium.wiki.gg/wiki/Ask_Klaasje_about_Sunday_night
- https://discoelysium.wiki.gg/wiki/Ask_%27Scab_Leader%27_about_tattoos
- https://discoelysium.wiki.gg/wiki/The_victim%27s_tattoos
- https://discoelysium.wiki.gg/wiki/Doorgunner_Megamix
- https://discoelysium.wiki.gg/wiki/Question_Klaasje_about_the_dead_man
- https://discoelysium.wiki.gg/wiki/Run_the_number_on_the_victim%27s_armour
- https://www.gamebanshee.com/discoelysium/walkthrough/runthenumberonthevictimsarmour.php
- https://discoelysium.wiki.gg/wiki/Find_Morell%2C_the_Cryptozoologist
- https://www.gamebanshee.com/discoelysium/walkthrough/findmorellthecryptozoologist.php
- https://discoelysium.wiki.gg/wiki/Find_working_class_husband
- https://discoelysium.wiki.gg/wiki/Get_two_signatures_for_Evrart
- https://discoelysium.wiki.gg/wiki/Add_even_more_beauty_to_the_wall
- https://discoelysium.wiki.gg/wiki/The_pissing_competition

Boundary and interface references:

- https://discoelysium.wiki.gg/wiki/Tasks
- https://discoelysium.wiki.gg/wiki/Look_for_Ruby_on_the_coast
- https://discoelysium.fandom.com/wiki/Tasks
- https://www.gamebanshee.com/discoelysium/walkthrough/gameplaynotes.php

Clothing and check references:

- https://discoelysium.wiki.gg/wiki/Clothing
- https://discoelysium.wiki.gg/wiki/Category:Skills

Thought references:

- https://discoelysium.wiki.gg/wiki/Wompty-Dompty_Dom_Centre
- https://discoelysium.wiki.gg/wiki/Actual_Art_Degree
- https://discoelysium.wiki.gg/wiki/Kvalsund_Multitool
- https://discoelysium.wiki.gg/wiki/Help_Soona_with_her_project

Treat source pages as evidence stores, not player-facing summaries. Some contain
major spoilers. Extract only the directional claim required by the current
question, and apply the project's spoiler rules before answering.
