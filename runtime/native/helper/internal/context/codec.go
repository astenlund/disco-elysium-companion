// Package context reproduces the runtime's prepared turn context: verified event records, the tagged context block,
// its semantic fingerprint, redelivery rendering, shape selection and the preparation request.
package context

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"strconv"

	"companion-helper/internal/events"
	j "companion-helper/internal/jsondoc"
)

const (
	MaximumBlockBytes = 4194304
	MaximumEvents     = 8192
)

var (
	opening        = []byte("<companion-turn-context>")
	closing        = []byte("</companion-turn-context>")
	templateFields = []string{"companionTurnContextVersion", "interactionId", "requestReceivedAt", "sessionOpening", "freshness", "operational", "correction"}
	// unbounded admits rendered blocks without document-profile budgets, as System.Text.Json's default reader does.
	unbounded = j.Budget{Bytes: MaximumBlockBytes, Tokens: 1 << 62, TextBytes: 1 << 62}
)

// Record is one verified journal event with a current full-payload acceptance.
type Record struct {
	Generation, JournalID, Game, Principal, EventID, Type string
	Sequence                                              int64
	BaselineReset                                         bool
	Warnings, Diff, State                                 []byte
}

// RecordFromFrozen verifies exact event bytes and extracts the parts a context renders.
func RecordFromFrozen(data []byte, expectedSha256, generation string, includeState bool) (*Record, error) {
	if !j.IsHex(expectedSha256, 64) || !j.IsHex(generation, 32) || events.Sha256Hex(data) != expectedSha256 {
		return nil, j.ErrInvalid
	}
	if _, err := events.Verify(data); err != nil {
		return nil, err
	}
	root, err := j.Parse(data, j.StateEvent)
	if err != nil {
		return nil, err
	}
	acceptance := root.Get("acceptance")
	if root.Get("compacted").Kind == j.True || acceptance.Kind != j.Object {
		return nil, j.ErrInvalid
	}
	acceptedGeneration := acceptance.Get("generation")
	if acceptedGeneration == nil || acceptedGeneration.Kind != j.String || acceptedGeneration.Str != generation {
		return nil, j.ErrInvalid
	}
	payload := root.Get("payload")
	sequence, err := j.AnyInteger(root.Get("sequence"))
	if err != nil {
		return nil, err
	}
	record := &Record{
		Generation: generation, JournalID: root.Get("journalId").Str, Game: root.Get("adapter").Str, Principal: root.Get("principal").Str,
		EventID: root.Get("eventId").Str, Sequence: sequence, Type: root.Get("type").Str, BaselineReset: payload.Get("baselineReset").Kind == j.True,
		Warnings: payload.Get("warnings").Raw, Diff: payload.Get("diff").Raw,
	}
	if includeState {
		record.State = payload.Get("state").Raw
	}
	return record, nil
}

// Selection is one carried event and whether it is a redelivery.
type Selection struct {
	Record     *Record
	Redelivery bool
}

// Rendering is one complete tagged context block.
type Rendering struct {
	Bytes         []byte
	Fingerprint   string
	EventCount    int
	StateIncluded bool
	Degraded      *string
}

// Redelivered is a rendering with every carried redelivery flag set to true.
type Redelivered struct {
	Bytes   []byte
	Offsets []uint32
}

// Render builds a tagged block, or returns nil when the exact bytes exceed maximum.
func Render(template []byte, selected []Selection, state *Record, generation string, degraded *string, omitDiff, omitWarnings bool,
	instructions, provider string, maximum int) (*Rendering, error) {
	validDegraded := degraded == nil || *degraded == "eventTooLarge" || *degraded == "stateTooLarge"
	if maximum < 1 || maximum > MaximumBlockBytes || !j.IsHex(generation, 32) || !validDegraded ||
		(omitDiff || omitWarnings) && len(selected) > 1 || omitWarnings && !omitDiff || omitDiff && degraded == nil {
		return nil, j.ErrInvalid
	}
	root, err := j.Parse(template, j.StateEvent)
	if err != nil {
		return nil, err
	}
	if err := validateTemplate(root); err != nil {
		return nil, err
	}
	identities := map[string]bool{}
	var previous int64
	for _, selection := range selected {
		record := selection.Record
		if record.Generation != generation || record.Sequence <= previous || identities[record.EventID] {
			return nil, j.ErrInvalid
		}
		identities[record.EventID] = true
		previous = record.Sequence
	}
	if state != nil && (state.Generation != generation || state.State == nil) {
		return nil, j.ErrInvalid
	}
	out := j.NewObject()
	for _, field := range templateFields {
		out.Raw(field, root.Get(field).Raw)
	}
	out.NullableString("degraded", degraded)
	eventsArray := []byte{'['}
	for index, selection := range selected {
		if index > 0 {
			eventsArray = append(eventsArray, ',')
		}
		eventsArray = append(eventsArray, writeEvent(selection, omitDiff, omitWarnings)...)
		// The C# writer measures its flushed output after each event: everything before this point plus the array so far.
		if len(out.Bytes())-1+len(`,"events":`)+len(eventsArray)+len(opening)+len(closing) > maximum {
			return nil, nil
		}
	}
	eventsArray = append(eventsArray, ']')
	out.Raw("events", eventsArray)
	if state != nil {
		out.Raw("state", state.State)
	} else {
		out.Null("state")
	}
	jsonBytes := out.Bytes()
	if len(jsonBytes)+len(opening)+len(closing) > maximum {
		return nil, nil
	}
	fingerprint, err := Fingerprint(jsonBytes, instructions, provider)
	if err != nil {
		return nil, err
	}
	block := make([]byte, 0, len(opening)+len(jsonBytes)+len(closing))
	block = append(append(append(block, opening...), jsonBytes...), closing...)
	return &Rendering{Bytes: block, Fingerprint: fingerprint, EventCount: len(selected), StateIncluded: state != nil, Degraded: degraded}, nil
}

func writeEvent(selection Selection, omitDiff, omitWarnings bool) []byte {
	record := selection.Record
	out := j.NewObject().String("eventId", record.EventID).Int("sequence", record.Sequence).String("type", record.Type).
		Bool("redelivery", selection.Redelivery).Bool("baselineReset", record.BaselineReset)
	if omitWarnings {
		out.Raw("warnings", []byte("[]"))
	} else {
		out.Raw("warnings", record.Warnings)
	}
	if omitDiff {
		out.Raw("diff", []byte("null"))
	} else {
		out.Raw("diff", record.Diff)
	}
	return out.Bytes()
}

// EventBytes is the encoded length of one carried event.
func EventBytes(selection Selection) int64 { return int64(len(writeEvent(selection, false, false))) }

func validateTemplate(root *j.Value) error {
	c := checker{}
	c.ok(j.Fields(root, templateFields...))
	if c.err != nil {
		return c.err
	}
	version, err := j.AnyInteger(root.Get("companionTurnContextVersion"))
	c.ok(err)
	c.require(version == 1)
	_, err = j.Token(root.Get("interactionId"))
	c.ok(err)
	_, err = j.Utc(root.Get("requestReceivedAt"))
	c.ok(err)
	_, err = j.Boolean(root.Get("sessionOpening"))
	c.ok(err)
	if c.err != nil {
		return c.err
	}
	freshness := root.Get("freshness")
	c.ok(j.Fields(freshness, "state", "class", "reason", "lastGoodGeneratedAt"))
	if c.err != nil {
		return c.err
	}
	state, err := j.Choice(freshness.Get("state"), "fresh", "failed")
	c.ok(err)
	fresh := state == "fresh"
	for _, field := range []string{"class", "reason"} {
		value := freshness.Get(field)
		if fresh {
			c.require(value.Kind == j.Null)
		} else {
			c.require(value.Kind == j.String && value.Str != "")
		}
	}
	if generated := freshness.Get("lastGoodGeneratedAt"); generated.Kind != j.Null {
		_, err = j.Utc(generated)
		c.ok(err)
	}
	operational := root.Get("operational")
	c.ok(j.Fields(operational, "state", "warnings"))
	if c.err != nil {
		return c.err
	}
	_, err = j.Choice(operational.Get("state"), "current", "unknown")
	c.ok(err)
	warnings := operational.Get("warnings")
	c.require(warnings.Kind == j.Array)
	if c.err != nil {
		return c.err
	}
	for _, warning := range warnings.Items {
		c.ok(j.Fields(warning, "code", "detail"))
		if c.err != nil {
			return c.err
		}
		_, err = j.Text(warning.Get("code"))
		c.ok(err)
		detail := warning.Get("detail")
		c.require(detail.Kind == j.String || detail.Kind == j.Null)
	}
	if correction := root.Get("correction"); correction.Kind != j.Null {
		c.ok(j.Fields(correction, "correctionId", "reason"))
		if c.err != nil {
			return c.err
		}
		_, err = j.Hex(correction.Get("correctionId"), 32)
		c.ok(err)
		_, err = j.Choice(correction.Get("reason"), "coreRejected", "contextUncertain")
		c.ok(err)
	}
	return c.err
}

// Redeliver flips every carried redelivery false to true and requires the semantic fingerprint to stay unchanged.
func Redeliver(rendered *Rendering, instructions, provider string) (*Redelivered, error) {
	data := rendered.Bytes
	if len(data) > MaximumBlockBytes || !bytes.HasPrefix(data, opening) || !bytes.HasSuffix(data, closing) {
		return nil, j.ErrInvalid
	}
	body := data[len(opening) : len(data)-len(closing)]
	root, err := j.Parse(body, unbounded)
	if err != nil {
		return nil, j.ErrInvalid
	}
	list := root.Get("events")
	if list == nil || list.Kind != j.Array || len(list.Items) != rendered.EventCount || len(list.Items) > MaximumEvents {
		return nil, j.ErrInvalid
	}
	var offsets []uint32
	for _, item := range list.Items {
		if item.Kind != j.Object {
			continue
		}
		flag := item.Get("redelivery")
		if flag == nil || flag.Kind != j.True && flag.Kind != j.False {
			return nil, j.ErrInvalid
		}
		if flag.Kind == j.False {
			offsets = append(offsets, uint32(len(opening)+flag.Start))
		}
	}
	if len(offsets) == 0 {
		return &Redelivered{Bytes: data, Offsets: []uint32{}}, nil
	}
	redelivery := make([]byte, 0, len(data)-len(offsets))
	source := 0
	for _, offset := range offsets {
		redelivery = append(redelivery, data[source:int(offset)]...)
		redelivery = append(redelivery, "true"...)
		source = int(offset) + 5
	}
	redelivery = append(redelivery, data[source:]...)
	fingerprint, err := Fingerprint(redelivery[len(opening):len(redelivery)-len(closing)], instructions, provider)
	if err != nil || fingerprint != rendered.Fingerprint {
		return nil, j.ErrInvalid
	}
	return &Redelivered{Bytes: redelivery, Offsets: offsets}, nil
}

// PackedOffsets is the shared little-endian offset table and each candidate's delta from it.
type PackedOffsets struct {
	Encoded []byte
	Deltas  []int
}

// PackRedeliveryOffsets packs the longest candidate's offsets and requires every other candidate to be a shifted prefix.
func PackRedeliveryOffsets(candidates []*Redelivered) (PackedOffsets, error) {
	var common []uint32
	for _, candidate := range candidates {
		if len(candidate.Offsets) > MaximumEvents {
			return PackedOffsets{}, j.ErrInvalid
		}
		if len(candidate.Offsets) > len(common) {
			common = candidate.Offsets
		}
	}
	deltas := make([]int, len(candidates))
	for candidateIndex, candidate := range candidates {
		offsets := candidate.Offsets
		delta := 0
		if len(offsets) > 0 {
			delta = int(offsets[0]) - int(common[0])
		}
		for index, offset := range offsets {
			if offset > MaximumBlockBytes-5 || index > 0 && offset < offsets[index-1]+5 || int64(common[index])+int64(delta) != int64(offset) {
				return PackedOffsets{}, j.ErrInvalid
			}
		}
		deltas[candidateIndex] = delta
	}
	packed := make([]byte, 4*len(common))
	for index, offset := range common {
		binary.LittleEndian.PutUint32(packed[4*index:], offset)
	}
	return PackedOffsets{Encoded: packed, Deltas: deltas}, nil
}

type checker struct{ err error }

func (c *checker) ok(err error) {
	if c.err == nil && err != nil {
		c.err = j.ErrInvalid
	}
}

func (c *checker) require(condition bool) {
	if c.err == nil && !condition {
		c.err = j.ErrInvalid
	}
}

// ErrUnavailable is the single failure class of context preparation.
var ErrUnavailable = errors.New("context unavailable")

func sha(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func itoa(value int) string { return strconv.Itoa(value) }
