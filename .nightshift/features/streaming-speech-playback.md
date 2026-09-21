---
status: exploring
---

# Streaming speech playback

Add optional, low-latency speech playback to the TUI through a configured Speaches service. The player can listen to one assistant message on demand or keep future messages flowing through a continuous queue while the quake-mode TUI is dismissed. The projection contract requires spoken output to preserve every substantive detail from the visual response and never summarize or shorten the answer.

That guarantee describes compliant narration, not an assertion that missing model output can be reconstructed deterministically. After the configured grace, an unresolved layout-dependent block may emit the explicit visual-reference failure cue settled below. The cue is the sole deliberate degradation, is logged as a model contract failure rather than treated as complete narration, and never replaces or shortens the canonical stored visual content. A later accepted repair restores full-detail replay.

## Operating context

- Deployment environment and operational criticality: this is an optional capability in one player's Windows companion, used during a live mid-playthrough session with either local or cloud model providers and an external Speaches container. Speech failure must never block visual chat, state acquisition, or the game, and the feature never writes game saves.
- Audience: the user, operator, and data owner are the same trusted individual, so the audience category is `personal use`.
- Failure consequence and data sensitivity: missing or incorrect speech can mislead or interrupt the player, but the visual response remains canonical and available. Persisted repairs and private diagnostic logs may contain response and playthrough context, so they remain identity-scoped and excluded from model context and player-facing UI.
- Concurrency and compatibility risk: the feature crosses streamed model output, structured rendering, queue admission, audio buffering, local serialized model work, cloud concurrent agents, provider capability declarations, and an independently versioned Speaches API.
- Reversibility and recovery cost: synthesized audio and queue state are process-local, visual content remains available, and persisted prose repairs are keyed idempotently by response ID and block ID. Dependency outages retain admitted work and recover through probing without mutating game state.
- Expected lifetime: this is intended as a durable TUI and runtime capability across providers and future game adapters, not a one-session experiment.

Rigor derivation records every judgment boundary. `personal use` supplies the low baseline because one trusted owner operates the companion. The `concurrency_compatibility` uplift fires because several ordered asynchronous boundaries and provider modes must interoperate. The `expected_lifetime` uplift fires because the protocol and queue become durable runtime architecture. The `deployment_criticality`, `failure_consequence`, and `reversibility_recovery` uplifts do not fire because the capability is optional, visual chat remains canonical, no game save is written, and retained state has bounded recovery paths. Running the deterministic derivation with `personal use` and two fired uplifts yields tier `high`; validation, recovery, compatibility, observability, and proof effort are all `high`.

## Ownership and boundaries

- The TUI owns hotkeys, playback status, capability-dependent help, and alerts.
- The companion runtime owns admission mode, ordered message frontiers, the playback queue, buffering, pause timing, catch-up, and process-lifetime state.
- A deterministic speech projector converts streamed response events into speakable segments and validates the structural contract for layout-dependent blocks.
- A repair coordinator requests missing, invalid, or semantically rejected prose alternatives and persists accepted repairs with the response.
- The runtime background-work broker owns semantic validation job lifecycle.
- A provider-aware model coordinator arbitrates foreground responses, repair, validation, and other companion model requests.
- A Speaches adapter submits text and consumes streamed audio. Speaches is an external dependency: the companion neither starts nor manages its container.
- The audio player consumes buffered segments independently of TUI visibility. Dismissing the TUI never pauses or abandons admitted playback.

The feature crosses presentation and runtime boundaries but does not enter the game-state core or any adapter domain. Speaches requests are external service activity and are not scheduled as companion model requests.

## Response projection contract

Ordinary prose passes through a deterministic syntax-only renderer. It removes or expands visual markup that would be awkward when spoken while preserving the original semantics and all details. It records message, paragraph, sentence, and segment boundaries for buffering and rewind behavior. Its supported mappings are canonical:

| Input construct | Spoken projection |
|---|---|
| Plain text and escaped Markdown punctuation | The decoded literal text. |
| Paragraph, soft break, or hard break | A paragraph boundary with no text, one ASCII space, or a sentence boundary with no text respectively. No adjacent words are joined. |
| ATX or setext heading | The heading text followed by a paragraph boundary. Heading markers and closing markers are not spoken. |
| Emphasis, strong emphasis, or strikethrough | The complete inner text without delimiter characters. |
| Inline code | The complete literal code span, with delimiter characters and delimiter-padding spaces removed. Internal whitespace remains intact. |
| Inline link `[label](target "title")` | The complete label, then `link to`, then the complete decoded target, then `titled` and the complete title when present. |
| Reference link `[label][key]` or `[key][]` | The complete label, then `reference`, then the complete key. Its definition is projected separately at the definition site. |
| Link-reference definition | `Reference`, the complete key, `link to`, the complete decoded target, then `titled` and the complete title when present. |
| Automatic link or bare URI | `link to` followed by the complete decoded target. An email target is introduced by `email`. |
| Image | Layout-dependent and therefore requires a speak-first alternative; alt text, target, and title remain in the visual input supplied for repair and semantic validation. |
| Footnote marker and definition | A marker projects as `reference` plus its complete label. Its definition projects at the definition site as `Reference`, the complete label, and the complete definition content. |
| HTML or numeric entity | Its decoded character or textual value. |
| Raw inline HTML | The complete source text, including tag delimiters, emitted literally and logged as a projection failure. |
| CommonMark HTML block, fenced or indented code block, block quote, thematic break, list, table, definition list, or other block-level extension | Layout-dependent and therefore requires a speak-first alternative. |

The renderer recognizes CommonMark plus the explicitly listed link, footnote, table, strikethrough, and definition-list extensions. A bracketed citation that is not parsed as a link or footnote is ordinary literal text, including its brackets. Raw inline HTML and every unrecognized or malformed inline construct are emitted literally, including their delimiters, and logged as projection failures; the renderer never guesses and never silently discards source text. Entity decoding that would produce a control character instead emits the source entity literally and logs the failure.

Projection is chunk-boundary invariant. The streaming parser buffers only an incomplete construct needed to decide one of these mappings; for every partition of the same source bytes, concatenated emitted segments and boundary metadata equal the result of projecting the source as one block. End of message closes the parser: any still-incomplete construct follows the literal malformed-input rule.

Sentence boundaries use a repository-owned grammar over projected text, so runtime or dependency upgrades cannot silently change rewind positions. A candidate terminator is an ASCII period, exclamation mark, or question mark. The boundary follows the maximal terminator run and any immediately following ASCII double quote, apostrophe, closing parenthesis, closing square bracket, closing brace, or Unicode closing quotation marks U+2019 and U+201D, but only when the next code point is whitespace or the paragraph or message has ended. The next sentence begins at the first following non-whitespace code point. A hard break always closes the current non-empty sentence. A paragraph or message end closes its final non-empty sentence even without a candidate terminator. Inline code, link targets, and email targets are atomic runs and never gain internal sentence boundaries. Empty text creates no sentence. These rules operate after entity and escape decoding and before synthesis segmentation.

Lists, tables, option dialogs, and every other block whose meaning depends on layout carry a hidden, model-authored flowing-prose alternative. One alternative covers the whole corresponding visual block. Dialog alternatives therefore form one prose passage rather than a stilted option-by-option recital.

### Speak-first block ordering

The model emits each hidden prose alternative before its corresponding visual block. The prelude contains exactly these fields:

- a response-unique authored block ID matching `[a-z][a-z0-9-]{0,63}`;
- a descriptive reference name;
- the visual block type; and
- the complete flowing-prose alternative.

After XML entity decoding, the reference name is normalized to Unicode Normalization Form C, outer Unicode whitespace is removed, and every internal whitespace run becomes one ASCII space. The normalized name must contain at least one Unicode letter or number, contain 1 through 80 Unicode scalar values, and contain no C0 or C1 control. Validation and process-lifetime uniqueness use ordinal, case-sensitive comparison of that normalized value. A blank, overlong, control-bearing, or otherwise invalid name is never truncated or admitted; it follows the emergency-reference path while the received value remains available for diagnostics.

For raw streamed text, the provider writes a top-level `<companion-alt>` element immediately followed by its top-level `<companion-visual>` element. Each opening element carries required `id`, `name`, and `type` attributes. The `type` grammar is an open lowercase identifier matching `[a-z][a-z0-9-]*`, so renderers can add visual block kinds without revising a closed enumeration. Attribute values use XML entity escaping.

Raw element content has one canonical collision escape: the provider replaces every source ampersand with `&amp;` and then every source less-than sign with `&lt;`; greater-than signs and quotes remain literal in content. The parser recognizes only those two content entities and decodes exactly once after finding the raw end tag. Decoding is one left-to-right token pass whose replacement output is never rescanned. A source entity such as `&amp;` is therefore transported as `&amp;amp;` and restored exactly, while literal `<companion-alt>` and `</companion-visual>` text cannot be mistaken for structure. Invalid or unknown content entities are contract failures rather than partially decoded text. Typed provider events carry raw unescaped content and do not apply this textual transport transform.

Elements cannot nest, appear inside Markdown code fences, or omit an end tag. Alternative content must decode to non-whitespace prose; visual content must decode to a non-whitespace renderable block. Wrapped decoded lines inside alternative content join according to the ordinary prose renderer, blank lines retain paragraph boundaries, and decoded visual content is preserved exactly. The streaming parser buffers incomplete UTF-8 code units, entities, opening tags, and closing tags across arbitrary chunk boundaries before classifying them. Typed provider events carry the same fields, ordering, content, and empty-form rules without the textual tags.

The following visual block carries the same authored block ID and reference name. It adds no spoken text. The persistence layer allocates an immutable stored-response ID before the first response delta. Allocation is atomic, unique within the identity-scoped persistence root, never reused after deletion, and durable across process restarts. If allocation fails, visual streaming continues but speech admission, repair, and validation are disabled for that response and the failure enters the operational log. Speech never creates an unaddressable repair target or blocks visual chat.

As soon as a well-formed prelude closes, the runtime registers one provisional queue slot keyed by `(stored-response ID, canonical block ID)` and may begin synthesis. Every top-level layout-dependent visual block receives a canonical internal ID `visual-{ordinal}`, where `ordinal` is its one-based position among those blocks in the stored response. The canonical ID is independent of the authored ID, recorded in structured response metadata, unique within the response, and deterministic on replay. Missing, malformed, mismatched, and duplicate authored IDs remain diagnostic protocol values and never serve as association keys. This allocation gives distinct IDs to multiple unwrapped blocks without a collision namespace. Every runtime queue, audio, validation, and repair association uses the composite canonical key.

The slot cannot cross the playback frontier until the following visual opening metadata validates its authored ID, name, and type. Successful validation promotes that same slot to playable immediately, without waiting for the visual content or closing boundary. This preserves speak-first latency while preventing unverified prose from reaching playback.

Reference names are model-authored and must be unique within one companion runtime process lifetime. The runtime creates an empty name registry at process startup, records each accepted name, rejects reuse, and discards the registry at process exit. Names may repeat after a runtime restart. More descriptive names are preferred because unresolved blocks use the name in a spoken visual reference.

The projector accepts either typed response blocks or arbitrary streamed text deltas. The streaming adapter buffers only incomplete syntax, emits each stable block immediately, and associates preludes and visual blocks by response ID and block ID. The validator performs no model calls. It checks protocol shape, prelude presence, identity agreement, block type agreement, and name uniqueness as soon as the relevant boundary is known.

An alternative must immediately precede its matching visual block except for whitespace. A visual block followed by its alternative, a duplicate or mismatched ID, a mismatched name or type, a nested element, an empty element, and an unmatched element are invalid. Queue-bound slot transitions acquire the queue lock before the slot lock. If the following visual opening has a mismatched ID, name, or type, the projector converts the provisional slot into the one pending-repair slot for that visual block, retires its provisional synthesis-attempt token, logically cancels the associated generation lease, and discards any synthesized provisional audio. It invokes the collected cancellation handle only after both locks are free. It never adds a second slot. The rejected prelude is logged with both identities, and any normalized prelude name already registered remains reserved for the process lifetime. The visual opening's normalized name becomes the pending slot's reference and is registered only when it is usable and not already registered; otherwise the slot receives an emergency reference. A rejected prelude name never wins a mismatch, even when it is usable. Because provisional audio is not playable, it cannot already have crossed the playback frontier. If non-whitespace content other than a matching visual opening arrives first, or the response ends first, the projector removes the provisional slot, retires its token, logically cancels its generation lease, and invokes the collected handle after releasing both locks. It then logs the prelude as orphaned and processes the newly encountered content normally. If the model emits an unwrapped layout-dependent Markdown block, the ordinary renderer still identifies its completed block boundary and reports the missing wrapper and alternative rather than treating the block as prose.

When an invalid or unwrapped block has no usable descriptive name, the runtime assigns a unique emergency reference from the renderer's block type and process-lifetime counter, such as `table T1`. The emergency name is persisted with any later repair and logged as a model contract failure. It exists only to keep the visual fallback speakable; the model-authored descriptive name remains the normal contract.

The validator cannot judge semantic completeness. A structurally valid but incomplete alternative is admitted and later assessed by semantic validation. Once matching visual opening metadata promotes the slot, later malformed or empty visual content is logged but does not retract prose that may already have played. The raw response remains the visual source of record; prose repair never invents replacement visual content.

## Missing alternatives and repair

When a visual block boundary arrives without a valid matching prelude, the projector inserts a pending queue slot and requests a targeted repair immediately. The repair input contains the affected visual block and its identifying metadata, not the whole conversation.

An accepted repair is inserted before the visual block in the stored structured response, keyed idempotently by `(stored-response ID, canonical block ID)`. Repair validation and persistence are generation-independent. A returned repair is revalidated and persisted by its canonical identity even when the requesting queue generation is stale; only its attempted mutation of a stale queue is discarded. If the stored response no longer exists, persistence returns a typed missing-target failure, the repair is logged, and no queue is mutated. While the current-generation slot remains `pending`, an accepted repair contends under the queue lock and then the slot lock, retires any prior attempt token, atomically changes the slot to `repair-selected`, logically cancels and collects the grace-timer lease, installs the repaired text, and allocates a fresh synthesis-attempt token. After releasing both locks, it invokes the timer's cancellation handle and schedules repaired-text submission. Once fallback has been selected or playback has passed the slot, a later repair is persisted for replay only and never changes current-generation text.

The repair coordinator owns one durable retry record per `(stored-response ID, canonical block ID)`, with a reason set that accumulates missing, invalid, and semantic-rejection classifications without creating duplicate jobs. It creates the record before the immediate initial request with attempt count zero, next-eligible time now, and the current prompt-version identity. Claiming an eligible record is atomic: it increments the attempt count and sets a lease that outlives the model coordinator's request timeout. An invalid repair, model error, or expired claim is a failed attempt and sets `nextEligibleAt` using a deterministic delay of `min(5 * 2^(attemptCount - 1), 3600)` seconds with saturating arithmetic and no jitter. Due records remain in the repair class even when they exist only for future replay; current-generation pending slots run before replay-only retries, and both remain below foreground work and above semantic validation. Neither bypasses local serialization.

Repair jobs survive queue replacement, runtime exit, and provider recovery. Startup reclaims expired leases and queues due records when speech is configured; an unconfigured feature leaves them dormant. Acceptance atomically inserts or replaces the prose, clears any semantic-rejection marker, and completes the retry record. If those writes cannot share a transaction, insertion occurs first and startup or the next scan completes any record whose accepted prose is already present without another model call. Deleting the stored response cascades its retry records. These are the only terminal conditions: accepted persisted prose or target deletion. After fallback selection, retries continue for future replay but never reopen current-generation text. Every failed attempt and final outcome enters the canonical model-failures log.

An unresolved pending slot receives one grace timer, default 2.5 seconds. The timer starts at the earlier of two events: the slot becomes the first barrier preventing contiguous audio from satisfying the initial-buffer predicate, or the playback frontier reaches the slot. This allows a short response to resolve its pending slot even before audible playback while preserving the intended pause when enough preceding audio already satisfied the initial buffer. Narration received before or during the grace is queued immediately; the runtime never waits deliberately when text is ready. Repair acceptance and grace expiry contend under the slot lock, so exactly one selects current-generation text. If grace expiry wins, it atomically changes `pending` to `fallback-selected`, freezes this fallback for the current generation, allocates a new synthesis-attempt token, and submits the text:

> For full details, see {referenceName}.

Selecting fallback or repaired text does not make the slot synthesis-terminal. The slot contributes valid playable duration only after synthesis with the current attempt token completes. Every retry allocates a new token. A synthesis callback may mutate a slot only when its queue generation, attempt token, and selected state all match; every stale callback is discarded. A retryable synthesis failure returns the selected text to unsynthesized work for outage recovery without reopening repair selection. A response-specific non-retryable synthesis failure makes the slot terminal with no audio, records the operational failure, and permits the initial-buffer predicate to observe that no further audio can contribute.

A late repair is still persisted and logged but is not inserted behind the listener's current position.

## Controls and state machine

The feature has two independent state dimensions:

- Admission mode is either `single-message` or `continuous`.
- Playback is `idle`, `buffering`, `playing`, or `paused`.

The runtime starts in `single-message` mode with an empty, idle queue. Mode controls admission only. Changing mode never pauses, clears, replaces, or rewinds the queue.

The TUI exposes three hotkeys whenever Speaches is available:

1. Play latest message.
2. Play or pause.
3. Toggle admission mode.

Whenever continuous admission is enabled, the mode toggle remains visible and usable even while Speaches is unavailable, so the player can stop later admission. After a successful use, an outage also retains Play or pause while the queue is non-idle. Play latest stays hidden because the unavailable service cannot synthesize a new one-shot. These recovery controls disappear when their retained state no longer applies. An unavailable startup and an outage before successful use expose no other speech controls.

Selecting an older message for one-shot playback is a future extension.

### Play latest

If the conversation has no assistant message, Play latest is a no-op in every playback state and mode. This guard is evaluated before the table.

| Playback | Mode | Result |
|---|---|---|
| Playing | Either | No operation. |
| Buffering | Either | No operation. |
| Paused | Continuous | No operation because the automatic queue is protected. |
| Paused | Single-message | Replace the queue and begin the latest message. |
| Idle | Either | Begin the latest message. |

An idle one-shot in continuous mode does not disable continuous admission. Future messages append behind the one-shot. Playing or buffering is always protected: Play latest never interrupts active output.

To replace an automatic queue that is already paused, the player disables continuous mode and invokes Play latest. If the automatic queue is playing or buffering, the player disables continuous mode, pauses playback, and then invokes Play latest. Messages already admitted before continuous mode is disabled remain queued until that explicit replacement. Without a later replacement, an admitted in-flight response finishes entering the queue even when the mode is disabled before that response finishes streaming.

Every persisted response event receives a strictly increasing event offset before publication, beginning at one for each stored-response ID. Response events include streamed model deltas, canonical metadata, repair insertion, and every other structured-response mutation. The persistence API atomically returns a snapshot through offset N and an unattached continuation beginning at N plus one. The continuation has `buffering`, `muted`, and `live` delivery phases. Both `buffering` and `muted` retain later events in offset order and cannot invoke queue callbacks.

Replacement selects the latest response at that persistence snapshot; successful queue mutation linearizes later at candidate publication. The runtime creates a candidate replacement generation with a fresh initial-buffer gate and a staged projection plan. Candidate projection stages every derived side effect, including synthesis, repair requests, validation candidates, diagnostic records, and structured-response mutations; it performs none before publication. The continuation is bound to the candidate in `muted` phase, and its buffered events are folded into the staged plan in strict offset order.

Installation uses explicit acquired-lock tracking and an exception-safe release path. The runtime acquires the queue lock first. If continuation-delivery-lock acquisition fails or is cancelled, it releases the queue lock immediately before propagating the typed installation failure. Once both locks are held, it folds newly buffered events into the plan and verifies contiguous offsets. Candidate publication, old-generation staling, transition of its live generation leases to `cancelled`, collection of their cancellation handles, the new `buffering` state, and the cursor's `muted` to `live` transition form one non-throwing in-memory commit. No cancellation handle is invoked and no fallible operation occurs between the first committed field and completion of that commit.

On successful commit, while still holding the delivery lock, the runtime releases the queue lock first and then releases the delivery lock. The delivery lock prevents live callbacks during that release interval. On any failure before commit, it leaves the old generation unchanged and performs only non-throwing internal rollback while the locks are held, including muting and marking the candidate cursor detached. It then releases the queue lock first when held, releases the delivery lock when held, and only afterward performs fallible cleanup or failure logging. Lock release therefore occurs on success, failure, and cancellation, and no external work runs while either installation lock is held.

After a successful commit and lock release, the runtime invokes the collected cancellation handles, stops old playback, and disposes old resources. Those operations target the stale generation explicitly, are idempotent, and never run under an installation lock. Staged durable response effects, namely repair requests, validation candidates, diagnostics, and structured-response mutations, release generation-independently and retain their canonical idempotency keys. Queue-bound effects, including synthesis, audio, and timers, require a generation lease with states `registered`, `dispatching`, `cancelled`, and `complete`.

All lease transitions contend under the queue lock:

| Current state | Event and guard | Result |
|---|---|---|
| `registered` | `TryBeginDispatch` while its generation is current | Change to `dispatching` and return true. |
| `registered` | `TryBeginDispatch` after its generation is stale | Change to `cancelled`, collect its handle for after-lock invocation, and return false. |
| `dispatching` | Effect completion wins the lock before replacement | Change to `complete`; publish its result only if callback generation and attempt-token guards also pass. |
| `registered` or `dispatching` | Replacement wins the lock | Change to `cancelled` and collect its handle for after-lock invocation. |
| `registered` or `dispatching` | Its current-generation owner explicitly cancels it | Change to `cancelled` and collect its handle for after-lock invocation. |
| `complete` or `cancelled` | Any later start, completion, or cancellation event | No operation; both states are terminal and `TryBeginDispatch` returns false. |

Lease acquisition atomically verifies the candidate is current and registers its cancellation handle in `registered`. Every transition that collects a handle invokes it only after releasing every lock held by that transition, including slot, queue, continuation-delivery, and installation locks. Synchronous token callbacks therefore cannot re-enter protected state or the non-throwing commit. If dispatch-start wins, the effect is logically in flight and a later replacement cancels its supplied token. If replacement wins, dispatch-start fails. If completion wins, replacement observes terminal `complete` and does not cancel it. The adapter receives the token and callback guards still reject stale generations. No queue-bound effect can newly linearize after its generation becomes stale, while already-started work remains subject to best-effort cancellation. Live callbacks therefore observe a fully published generation, and generation-independent persistence remains available for replay.

If snapshot, projection, cursor binding, offset verification, or pre-commit installation fails, the rollback and release path above detaches the new cursor and abandons the staged plan and uninstalled generation without derived external side effects. After every acquired lock is free, the runtime discards remaining resources and records one operational failure outside the abandoned plan.

If the selected response is still streaming, its attached cursor delivers every later persisted event to the replacement generation exactly once. Deltas for any other response finish persistence but cannot enter the replacement queue. Every projection, synthesis, and audio callback carries its queue generation; a callback from a stale generation is discarded and cannot mutate current state. This explicit replacement is the exception to the otherwise protected completion of an admitted in-flight response.

### Continuous admission and catch-up

Enabling continuous mode establishes a forward admission frontier. With an empty queue, only later assistant messages are admitted. With one or more messages in the queue and `Tts.CatchUpOnContinuousEnable` enabled, the runtime finds the most recent queued message, including the active item, and appends every available assistant message after it in conversation order. Message IDs prevent duplicate admission. The setting defaults to `true`; setting it to `false` restores future-messages-only behavior.

Continuous admission remains active when playback is paused or when the queue is temporarily drained. Stable text from later admitted messages can be projected and synthesized while paused. Disabling continuous mode stops admission of later messages but does not change playback or remove anything already admitted.

### Pause and resume

Play or pause has exhaustive state behavior:

| Playback before command | Result |
|---|---|
| Idle | No operation. The command does not admit a message. |
| Buffering | Enter paused. In-flight projection and synthesis continue, but no audio starts and the initial-buffer gate is retained. |
| Playing | Enter paused at the current sentence and paragraph position. In-flight projection and synthesis continue. |
| Paused with an unsatisfied retained initial-buffer gate | Rewind by elapsed pause time, enter buffering, and wait until the live initial-buffer predicate is satisfied. Partial playable audio never bypasses this gate. |
| Paused with the initial-buffer gate satisfied and playable rewind audio available | Rewind by elapsed pause time, then enter playing immediately. |
| Paused with refill needed at the rewind boundary | Rewind by elapsed pause time, enter buffering, request or continue synthesis from that boundary, and enter playing when playable audio exists. |

Pause affects playback only in both admission modes. It never cancels projection or synthesis, changes admission, removes queued messages, or resets the initial buffer already accumulated. Later queued messages remain intact. Resume rewinds within the current message according to elapsed pause time:

| Time paused | Restart boundary |
|---|---|
| 0 through 2 minutes | Beginning of the current sentence. |
| More than 2 through 10 minutes | Beginning of the current paragraph. |
| More than 10 minutes | Beginning of the current message. |

Exactly 2 minutes uses the sentence boundary. Exactly 10 minutes uses the paragraph boundary.

## Streaming and buffering

For every admitted response, the projector submits each stable speakable segment to Speaches immediately. It never waits for the complete assistant response. The audio player begins when playable audio exists and the configured initial buffer is satisfied, defaulting to 5 seconds.

The initial-buffer gate is a live predicate over valid, contiguous playable duration from the current playback frontier, not a historical boolean. It opens when that duration reaches the configured target. The short-response branch opens it below target only when source projection has ended and every synthesis or fallback slot through message end is terminal, proving no more audio can contribute. A pause while buffering retains the valid accumulated audio and the same predicate. Discarding or invalidating audio immediately recomputes the duration and can make the predicate unsatisfied before first playback; resume cannot weaken it. Once playback has begun for that queue generation, later underruns use ordinary buffering and do not recreate the initial gate.

The external contract was checked on 2026-08-29 against Speaches master commit [`993994f`](https://github.com/speaches-ai/speaches/tree/993994f7984bf3fe9655b267448328cf66fccb42), including its [speech router](https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/routers/speech.py), [audio formatter](https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/audio.py), and [public health route](https://github.com/speaches-ai/speaches/blob/993994f7984bf3fe9655b267448328cf66fccb42/src/speaches/routers/misc.py). The adapter pins this wire contract rather than negotiating from defaults:

- `POST /v1/audio/speech` sends the configured model, voice, and speed plus `stream_format: "audio"`, `response_format: "pcm"`, and `sample_rate: 24000`;
- success is HTTP 200 with media type `audio/pcm` and a streamed body of headerless, mono, signed 16-bit little-endian PCM at 24,000 Hz;
- HTTP chunk boundaries are unrelated to sample boundaries, so the adapter retains an odd trailing byte until the next chunk and rejects an odd final byte;
- playable duration is exactly `completePcmByteCount / 48000` seconds, using only contiguous bytes admitted by the segment and generation frontiers; and
- a non-200 response, wrong media type, malformed byte stream, timeout, or premature connection end follows the partial-stream failure rule.

An incompatible deployed Speaches version is unavailable rather than subject to a codec fallback. Implementation re-verifies the configured Docker image against this contract and either updates this design deliberately or fails closed for speech without affecting visual chat.

The queue retains boundary metadata alongside synthesized audio and unsynthesized text. Resume can therefore restart at a known sentence, paragraph, or message without re-parsing unaffected later content. Each submitted speakable segment is one synthesis commit unit with states `unsynthesized`, `in-flight`, and `complete`; successful end of the streamed response advances the synthesis frontier to `complete`.

If a Speaches stream fails mid-segment before any of its audio crosses the playback frontier, the runtime discards every buffered byte from that request and resets the segment to `unsynthesized`. If any audio from the failed segment has already played, the runtime also discards its unplayed buffered bytes, resets the whole segment to `unsynthesized`, and records that the listener heard a partial attempt. Only complete segments strictly before the failed segment may finish playback. Complete later segments remain retained but unplayable behind the failed frontier. Recovery resubmits the entire failed segment from its beginning before releasing any later segment, so a partial attempt may be repeated but no source text is omitted. Completed earlier segments remain committed and are not repeated by outage recovery.

While playback is active, failure leaves the player in `buffering` after all eligible earlier audio drains; recovery continues automatically. A user pause before or during the outage leaves the player `paused`, and recovery may refill the queue without starting audio until the user resumes.

Synthesized audio is process-local and need not survive a runtime restart. Stored repairs do survive through the normal response persistence mechanism and may be synthesized again on replay.

## Semantic alternative validation

Every accepted visual and prose pair creates a low-priority validation candidate. Candidates are generously debounced, default 60 seconds, and run only when other model activity is idle. A validation job receives exactly the paired visual and prose blocks plus their identifying metadata. It receives no conversation, play-session, or agent-session context.

The model judges whether the prose preserves every visual detail. A mismatch, malformed validation result, or validation error is logged. A mismatch stores a SHA-256 fingerprint of the rejected prose's exact UTF-8 bytes after textual-wrapper decoding and LF newline normalization, marks the pair `semantic-repair-required`, and creates or refreshes its durable repair record. The block retains its set of rejected fingerprints until stored-response deletion. A repair whose fingerprint matches that set is invalid: it cannot advance the prose revision or clear the marker, and it follows normal failed-attempt logging and backoff.

Mismatch handling also contends with playback under the queue lock and then the matching slot lock. If no audio from that slot has crossed the current playback frontier, it retires the attempt token, logically cancels and collects the generation lease, discards all rejected audio, and changes the slot to `pending`. If only a prefix has crossed, it preserves the irreversible played prefix, retires and cancels the attempt, discards every unplayed byte, changes the slot to `pending`, and records partial exposure. In both cases, after releasing both locks it invokes the cancellation handle and applies normal repair grace and fallback from the beginning of the block; accepted prose may therefore repeat a prefix but cannot knowingly continue rejected content. If the complete slot already crossed, current playback cannot change and full exposure is logged. A slot absent from the current generation receives only the persisted transition.

Future replay treats marked prose as unavailable and uses the pending repair and grace behavior rather than knowingly playing rejected text. An accepted replacement clears the marker and creates a new validation candidate. A malformed validation result or validation error leaves the pair unchanged because it is not evidence of a semantic mismatch. This keeps retrospective quality analysis off the latency-sensitive playback path while preventing a known mismatch from recurring.

Validation candidates are durable and keyed by `(stored-response ID, canonical block ID, prose revision, validation prompt version)`. A well-formed match or mismatch completes the candidate and retains its evidence. A malformed result or execution error records a failed attempt and makes the same candidate eligible again after the full configured debounce, subject to the idle gate. An accepted repair advances the prose revision, supersedes incomplete candidates for the older revision, and creates the new candidate described above; completed historical evidence remains diagnostic. Stored-response deletion cascades all of its validation candidates. With `NarrationValidation.Enabled` set to `false`, the broker creates no new candidates and claims no queued candidates. A running validation completes normally; any mismatch it returns still performs the fail-closed transition above. Existing candidates remain suspended, validation evidence remains stored, `semantic-repair-required` markers remain binding, and repair jobs continue independently. Restart while disabled preserves the same state and performs no catch-up scan.

When validation is enabled again, the broker resumes suspended candidates and scans stored accepted pairs for the current prose revision and prompt version that lack completed validation evidence. It inserts missing candidates idempotently, applies the full configured debounce from re-enable time, and admits them only through the normal idle gate. Re-enable never clears a rejection marker or makes rejected prose playable; only an accepted persisted repair does that.

## Provider-aware model execution

The runtime provider adapter declares its execution capabilities explicitly. The coordinator never infers local or cloud behavior from endpoint URLs or model names.

In local mode:

- one configured model identity serves foreground responses, missing-prose repairs, and semantic validation;
- only one companion model request executes at a time;
- jobs may choose different effort settings but cannot select another model;
- foreground generation has priority, followed by current-playback repair, replay-only durable repair, then background validation; and
- the single-model rule avoids simultaneous VRAM pressure and model-loading delays.

With a cloud provider:

- foreground generation, targeted repair agents, and validation agents may run concurrently;
- the global concurrency ceiling defaults to eight model requests;
- queued work uses strict class priority: foreground generation, then current-playback repair, then replay-only durable repair, then semantic validation;
- foreground requests use enqueue order, current repairs use message and block queue order with enqueue order as the tie-breaker, replay-only repairs use next-eligible time then canonical response and block identity, and validations use eligibility time after debounce with canonical response and block identity as the tie-breaker;
- already-running background work completes normally rather than being preempted; and
- job-specific model and effort selection is allowed only when the provider declares support.

The validation debounce and idle gate apply in both modes. Validation can start only when no foreground or repair work is running or queued. Once validation has started, later foreground or repair work may run concurrently in cloud mode because background work is not preempted. Speaches is outside this coordinator even when its external service uses local hardware.

## Speaches capability and alerts

A missing `Tts.Endpoint` means Speaches is not configured. The runtime performs no probe, and the TUI shows no speech controls, status, hotkey hints, or alerts.

When configured, the runtime probes once at startup and then at the configured interval, default 30 seconds, while unavailable. Each probe has the configured end-to-end timeout, default 10 seconds, and performs this exact sequence:

1. `GET /health` must return HTTP 200, media type `application/json`, and a JSON object whose `message` property is exactly `OK`.
2. The adapter sends the pinned speech request above with input `ready`, consumes but never plays the result, and requires HTTP 200, media type `audio/pcm`, at least one complete PCM sample, an even final byte count, and clean end of stream before timeout.

The health route is public in the checked Speaches contract. The capability request uses configured authentication when present and validates endpoint, model, voice, speed, format, sample rate, and streaming together. Probe audio never enters a playback queue and does not count as successful use. Any failed step keeps the current outage open and enters the operational log; a complete capability success closes it. Probing is silent except for the relevance-based alerts below. Recovery never requires a companion restart.

| Condition | Alert | Other speech UI |
|---|---|---|
| Configured but unavailable at startup | Once for that outage. | Hidden. |
| Was available but never successfully used | None when it becomes unavailable. | Mode toggle only when continuous admission is enabled. |
| Produced playable audio at least once, then became unavailable | Once for each outage. | Retained recovery controls only while applicable. |
| Becomes available again | No success alert. | Controls return. |

A successful use means Speaches produced playable audio during the current runtime session. Repeated failed probes during one outage never repeat its alert. Each outage has a stable notice ID. If the TUI's short-message mechanism is persistent, recovery resolves and removes the outstanding speech notice. A transient mechanism may ignore resolution after the notice expires, and a dismissed notice is not recreated until a later outage.

The TUI reuses an existing short-message mechanism if one exists. Otherwise this feature adds a small, non-modal alert surface that remains readable until dismissed, accepts typed deduplicated notice and resolution events, and can carry future runtime notices. Suggested copy is:

- Startup: "Speech is configured but unavailable. Check the Speaches service."
- After successful use: "Speech has become unavailable. Playback will resume if the service returns."

If Speaches fails after admission, eligible audio from complete synthesis segments before the failed frontier finishes and admitted unsynthesized entries remain queued. Complete later segments stay ordered behind that frontier. A failed in-flight segment follows the partial-stream recovery rule above. Continuous admission also remains active during the outage: later responses enter the queue as stable unsynthesized text in conversation order. On recovery, synthesis resumes automatically from the retained frontier. Messages produced while continuous mode was disabled are not admitted unless the player later enables continuous mode and the configured catch-up rule applies.

Speaches failures belong in the operational log, never the model-failures log.

## Operational evidence

The runtime appends non-model feature failures to `runtime-operations.jsonl` in the identity-scoped runtime data root. The log is private diagnostic state, never player-facing and never injected into model context. Each UTF-8 JSONL record includes timestamp, severity, stable event code, runtime-session ID, subsystem, outage or queue generation when applicable, stored-response and canonical block identities when applicable, provider and configured endpoint origin without path, query, credentials, or headers, sanitized exception type and message, attempt count, and recovery outcome. It never includes response prose, visual content, synthesized audio, authentication material, or endpoint query values.

The writer serializes one bounded record and newline, then performs one append under a process-wide file lock. On startup it scans the final line; if that line is unterminated or malformed, it appends a newline separator, reports one sanitized stderr notice, and leaves the damaged bytes intact for diagnosis. Readers skip malformed records and count them. The initial feature performs no automatic rotation or deletion; the operator may archive the file while the runtime is stopped, and the next append creates a new active file. If append fails, the feature increments an in-memory dropped-record count and emits one sanitized stderr notice per runtime session without recursively logging that failure. Operational logging failure never blocks visual chat, queue cleanup, alert state, or recovery. The malformed-line and dropped-record counts are included in the next successful operational record.

## Model-failure evidence

The runtime appends model contract failures to one canonical `model-failures.jsonl` file in the identity-scoped runtime data root. The log is private diagnostic state: it is never player-facing and never injected into ordinary model context. It is retained until a deliberate archive after prompt polish; the initial feature performs no automatic deletion.

The runtime logs every initially missing alternative even when repair succeeds, plus ordinary-projection failures, malformed or duplicate block identities and names, orphaned alternatives, repair failures, invalid repairs, semantic mismatches, malformed validation results, and validation errors. Each record includes:

- timestamp and stage;
- companion runtime-session ID;
- play-session and agent-session IDs when applicable;
- response ID, block ID, block type, and descriptive reference name;
- the original visual block and received prose when available;
- provider, model, effort, and prompt-version identity;
- failure classification and details; and
- repair or validation outcome and latency when applicable.

The runtime-session ID identifies which process-lifetime name registry admitted the block. Operational dependency failures are recorded elsewhere so prompt quality evidence remains canonical and focused.

## Configuration

The initial settings and defaults are:

```json
{
  "Tts": {
    "Endpoint": null,
    "Model": null,
    "Voice": null,
    "Speed": 1.0,
    "StartupBufferSeconds": 5.0,
    "RepairGraceSeconds": 2.5,
    "ProbeIntervalSeconds": 30,
    "ProbeTimeoutSeconds": 10.0,
    "CatchUpOnContinuousEnable": true
  },
  "NarrationValidation": {
    "Enabled": true,
    "DebounceSeconds": 60
  },
  "ModelExecution": {
    "CloudMaxConcurrency": 8
  }
}
```

`Tts.Endpoint` is the configuration switch. When present, model and voice values must also satisfy the selected Speaches deployment. Provider configuration owns local versus cloud classification and the local model identity; those values are not duplicated here.

An endpoint with missing or invalid required synthesis settings counts as configured but unavailable. Startup shows the configured-service alert and records the configuration failure in the operational log. Silent probing resumes only after configuration becomes structurally usable.

## Verification boundary

Deterministic tests cover:

- every Play latest, Play or pause, mode-toggle, queue-protection, catch-up, and resume truth table row, including an empty conversation, continued synthesis while paused, exact cursor handoff during replacement of an admitted stream, partial lock acquisition failure, stale-generation callback rejection, every generation-lease transition and terminal-state no-op, dispatch-start-versus-replacement and completion-versus-replacement lock interleavings, consecutive replacements before staged dispatch, and exact 2-minute and 10-minute boundaries;
- catch-up enabled by default, disabled by configuration, ordered by message ID, and deduplicated;
- every ordinary-prose mapping with exact output, malformed and unknown syntax, reference links and definitions, inline HTML versus HTML blocks, control-character entities, every sentence-boundary grammar branch, and identical output and boundary metadata under arbitrary streamed chunk partitions;
- streamed text and typed block-at-a-time input, including literal wrapper tokens, source entity text, invalid content entities, and wrappers or entities split at every byte boundary;
- speak-first alternatives plus missing, mismatched, duplicate, and orphaned blocks, including a single provisional-slot transition for mismatched ID, name, and type, proof that provisional audio cannot play, stable canonical IDs across restart, multiple unwrapped blocks, duplicate authored IDs, and identical authored block IDs in concurrent responses without cross-association;
- repair grace while a pending slot blocks a short response's initial buffer, the repair-versus-grace race, synchronous grace-timer cancellation callback re-entry, repair and fallback selection before synthesis completion, provisional and retry synthesis-attempt tokens, deterministic durable repair backoff, expired-claim recovery, partial completion writes, target deletion, late repair persistence, stale-generation repair persistence without stale queue mutation, every mismatched-name usability combination, invalid reference names, and replay of the repaired response;
- local single-model identity and absence of overlapping model requests;
- cloud foreground-over-repair-over-validation priority, deterministic within-class ordering, validation idle admission with later foreground overlap, and the eight-request ceiling;
- validation debounce, context-free payloads, the mismatch-versus-playback-frontier race, suppression of queued and partially played rejected audio, already-crossed exposure logging, rejected-prose fingerprint retention and identical-repair rejection, disable with a running job, disabled restart, re-enable catch-up and deduplication, rejection-marker retention, mismatch rejection and repair, malformed-result retention, revalidation of accepted repairs, and failure logging;
- pinned PCM request and decoding, odd HTTP chunk boundaries, malformed final samples, exact playable-duration calculation, health and capability probe success criteria, probe timeout, startup, outage, recovery, alert relevance, alert deduplication, persistent notice resolution, pre-success continuous-mode disablement, retained recovery controls, retained queues, automatic synthesis recovery, an earlier failed segment with a later complete segment, complete and partial in-flight segments, continuous admission during an outage, malformed operational-log tails, append failure, privacy redaction, and dropped-record recovery; and
- buffering, source completion with synthesis still in flight, invalidation after a target-sized paused buffer, retained initial-buffer gates, and grace timing through a fake Speaches endpoint and virtual clock.

An optional Docker-backed integration test verifies compatibility with the configured Speaches protocol. The ordinary suite never requires the external service or a real-time wait.

## Deferred integration decisions

The three command semantics are settled, but their physical key chords remain part of the TUI keymap design so they can be conflict-free and discoverable alongside the rest of the application. The implementation must also resolve the provider-neutral typed block representation and stored-response insertion API against the runtime and TUI contracts that eventually graduate. Those integrations must preserve the raw-text grammar and lifecycle above rather than redefining feature behavior.

This feature remains Exploring until the TUI presentation contract and the runtime background-work and provider-coordination seams are formal enough to declare resolvable backlog dependencies.

## Non-goals

- Selecting previous messages for one-shot playback.
- Starting, stopping, configuring, or packaging the Speaches container.
- Loading multiple companion models in local mode.
- Retracting audio that already crossed the playback frontier before a retrospective semantic mismatch.
- Persisting synthesized audio across runtime restarts.
- Shortening or summarizing spoken content.
- Adding game-state or adapter-domain responsibilities to the speech feature.
