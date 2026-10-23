package context

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"companion-helper/internal/events"
	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// These cases were carried over from the deleted Test-ContextCodec.ps1 suite. The payload sample mirrors the deleted
// New-RuntimePayloadSample and New-RuntimeAcceptedPayloadSample helpers; backslashes are built from their code point.

const (
	sampleTime     = "2026-10-07T01:23:45.1234567Z"
	contextOpening = "<companion-turn-context>"
	contextClosing = "</companion-turn-context>"
	codecTemplate  = `{"companionTurnContextVersion":1,"interactionId":"interaction","requestReceivedAt":"2026-10-08T06:00:00.0000000Z","sessionOpening":true,` +
		`"freshness":{"state":"fresh","class":null,"reason":null,"lastGoodGeneratedAt":null},"operational":{"state":"current","warnings":[]},"correction":null}`
	scopeDocument  = `{"runtimeScopeVersion":1,"game":"game","principal":"principal"}`
	safetyDocument = `{"stateSafetyVersion":1,"generation":"11111111111111111111111111111111","pendingCheck":null,"correction":null,"recoveryWitness":null}`
)

var backslash = string(rune(92))

type payloadSample struct {
	rawState, diff string
	source         []byte
}

func newPayloadSample(paddingBytes int, nestedFlags bool) payloadSample {
	sourceIdentity := `{"domainId":"` + strings.Repeat("a", 64) + `","saveFile":"save.zip","savedAt":"` + sampleTime + `","byteLength":1,"contentSha256":"` +
		strings.Repeat("b", 64) + `"}`
	floor := `{"domainId":"` + strings.Repeat("a", 64) + `","saveFile":"save.zip","savedAt":"` + sampleTime + `"}`
	padding := ""
	if paddingBytes > 0 {
		padding = `"padding":"` + strings.Repeat("x", paddingBytes) + `",`
	}
	nested := ""
	if nestedFlags {
		nested = `"redelivery":false,"nested":{"redelivery":false},"events":[{"redelivery":false}],"text":"` + backslash + `"redelivery` + backslash + `":false",`
	}
	rawState := `{"schemaVersion":2,"adapterVersion":1,"game":"game","generatedAt":"` + sampleTime + `","source":` + sourceIdentity + `,"extra":{` + nested + padding +
		`"number":9007199254740993,"decimal":0.123456789012345678901,"negativeZero":-0,"exponent":1e400,"escaped":"` + backslash + `u0061","timestamp":"` + sampleTime + `"}}`
	diff := `{` + nested + `"schemaVersion":2,"adapterVersion":1,"game":"game","currentGeneratedAt":"` + sampleTime + `","currentSource":` + sourceIdentity +
		`,"baselineGeneratedAt":null}`
	logical := strings.Repeat("c", 32) + "-1"
	source := `{"stateEventVersion":1,"logicalOutboxId":"` + logical + `","incarnationId":"` + strings.Repeat("c", 32) + `","sequence":1,"kind":"consumed","createdAt":"` +
		sampleTime + `","principal":"principal","repairOperationId":null,"adapterVersion":1,"game":"game","baseline":null,"sourceFloor":` + floor +
		`,"refresh":{"attempted":false,"commitObserved":false,"attempts":0},"warnings":[],"baselineReset":true,"diff":` + diff + `,"state":` + rawState + `}`
	return payloadSample{rawState: rawState, diff: diff, source: []byte(source)}
}

func eventMetadata(sequence int64, eventID, recordSha256 string, accepted bool) []byte {
	settlement, acceptance := "pending", "null"
	if accepted {
		settlement = "accepted"
		acceptance = `{"journalId":"journal","eventId":"` + eventID + `","generation":"` + generation + `"}`
	}
	return []byte(fmt.Sprintf(`{"eventVersion":1,"journalId":"journal","sequence":%d,"eventId":"%s","type":"state.consumed","occurredAt":"%s",`+
		`"runtimeInstanceId":"%s","adapter":"game","adapterBindingEpoch":"%s","principal":"principal","logicalOutboxId":"%s-1","recordSha256":"%s",`+
		`"coreRepairOperationId":null,"attemptRef":null,"schemaVersion":2,"adapterVersion":1,"settlement":"%s","acceptance":%s,"acknowledgedAt":null,"compacted":false}`,
		sequence, eventID, sampleTime, strings.Repeat("e", 32), strings.Repeat("f", 32), strings.Repeat("c", 32), recordSha256, settlement, acceptance))
}

// sampleEvents returns the pending event and its accepted rewrite for a sample.
func sampleEvents(t *testing.T, sample payloadSample) (pending, accepted []byte) {
	t.Helper()
	recordHash := events.Sha256Hex(sample.source)
	pending, err := events.CreateEvent(sample.source, eventMetadata(1, strings.Repeat("d", 32), recordHash, false))
	if err != nil {
		t.Fatal(err)
	}
	accepted, err = events.RewriteEvent(pending, eventMetadata(1, strings.Repeat("d", 32), recordHash, true), false)
	if err != nil {
		t.Fatal(err)
	}
	return pending, accepted
}

func frozenRecord(t *testing.T, data []byte, includeState bool) *Record {
	t.Helper()
	record, err := RecordFromFrozen(data, events.Sha256Hex(data), generation, includeState)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func render(t *testing.T, selected []Selection, state *Record, degraded *string, omitDiff, omitWarnings bool, maximum int) *Rendering {
	t.Helper()
	rendered, err := Render([]byte(codecTemplate), selected, state, generation, degraded, omitDiff, omitWarnings, instructions, provider, maximum)
	if err != nil {
		t.Fatal(err)
	}
	return rendered
}

func sliceSource(selected []Selection) EventSource {
	index := 0
	return func() (*Selection, error) {
		if index >= len(selected) {
			return nil, nil
		}
		index++
		return &selected[index-1], nil
	}
}

func selectShape(t *testing.T, shape int, selected []Selection, state *Record, failedBlockBytes *int) *Rendering {
	t.Helper()
	rendered, err := Select(shape, []byte(codecTemplate), sliceSource(selected), state, true, generation, instructions, provider, failedBlockBytes)
	if err != nil {
		t.Fatal(err)
	}
	return rendered
}

func body(t *testing.T, rendered []byte) *j.Value {
	t.Helper()
	text := string(rendered)
	if !strings.HasPrefix(text, contextOpening) || !strings.HasSuffix(text, contextClosing) {
		t.Fatalf("not one complete tagged context block: %.60s", text)
	}
	value, err := j.Parse([]byte(text[len(contextOpening):len(text)-len(contextClosing)]), unbounded)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestRecordFromFrozenRefusesPendingChangedAndForeignGenerationEvents(t *testing.T) {
	// Arrange
	pending, accepted := sampleEvents(t, newPayloadSample(0, true))
	changed := bytes.Replace(accepted, []byte("9007199254740993"), []byte("9007199254740994"), 1)
	cases := map[string]struct {
		data       []byte
		generation string
	}{
		"pending":            {pending, generation},
		"foreign generation": {accepted, strings.Repeat("2", 32)},
		"changed payload":    {changed, generation},
	}
	for name, c := range cases {
		// Act
		_, err := RecordFromFrozen(c.data, events.Sha256Hex(c.data), c.generation, true)

		// Assert
		if err == nil {
			t.Fatalf("a %s event was admitted", name)
		}
	}
}

func TestEventOnlyRecordsRenderIdenticalBytesWithoutRetainingState(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	eventOnly := frozenRecord(t, accepted, false)

	// Act
	full := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)
	projected := render(t, []Selection{{Record: eventOnly}}, record, nil, false, false, MaximumBlockBytes)
	_, stateless := Render([]byte(codecTemplate), []Selection{{Record: eventOnly}}, eventOnly, generation, nil, false, false, instructions, provider, MaximumBlockBytes)

	// Assert
	if record.State == nil || eventOnly.State != nil {
		t.Fatal("event-only records must verify the full payload without retaining historical state text")
	}
	if !bytes.Equal(full.Bytes, projected.Bytes) {
		t.Fatal("omitting historical state changed the selected context bytes")
	}
	if !errors.Is(stateless, j.ErrInvalid) {
		t.Fatalf("an event-only record used as state answered %v", stateless)
	}
}

func TestRenderingPreservesExactStateAndDiffTokens(t *testing.T) {
	// Arrange
	sample := newPayloadSample(0, true)
	_, accepted := sampleEvents(t, sample)
	record := frozenRecord(t, accepted, true)

	// Act
	rendered := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)
	document := body(t, rendered.Bytes)

	// Assert
	if string(document.Get("state").Raw) != sample.rawState {
		t.Fatalf("state values lost exact lexemes:\n%s", document.Get("state").Raw)
	}
	if string(document.Get("events").Items[0].Get("diff").Raw) != sample.diff {
		t.Fatalf("diff is not its exact validated token:\n%s", document.Get("events").Items[0].Get("diff").Raw)
	}
	if rendered.Degraded != nil || !rendered.StateIncluded || rendered.EventCount != 1 {
		t.Fatalf("candidate metadata %+v does not describe the full block", rendered)
	}
}

func TestRedeliveryFlipsOnlyDirectEventFlags(t *testing.T) {
	// Arrange
	sample := newPayloadSample(0, true)
	_, accepted := sampleEvents(t, sample)
	record := frozenRecord(t, accepted, true)
	rendered := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)

	// Act
	redelivered, err := Redeliver(rendered, instructions, provider)

	// Assert
	if err != nil {
		t.Fatal(err)
	}
	if len(redelivered.Offsets) != 1 || len(redelivered.Bytes) != len(rendered.Bytes)-1 {
		t.Fatalf("redelivery changed %d flags and %d bytes", len(redelivered.Offsets), len(rendered.Bytes)-len(redelivered.Bytes))
	}
	document := body(t, redelivered.Bytes)
	if document.Get("events").Items[0].Get("redelivery").Kind != j.True {
		t.Fatal("the direct event flag did not become true")
	}
	if string(document.Get("state").Raw) != sample.rawState || string(document.Get("events").Items[0].Get("diff").Raw) != sample.diff {
		t.Fatal("redelivery touched nested state or diff flags")
	}
	fingerprint, err := Fingerprint(document.Raw, instructions, provider)
	if err != nil || fingerprint != rendered.Fingerprint {
		t.Fatalf("redelivery changed the semantic fingerprint: %v", err)
	}
}

func TestRenderCapCountsTagsAndAllBytes(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	full := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)

	// Act
	tooSmall := render(t, []Selection{{Record: record}}, record, nil, false, false, len(full.Bytes)-1)

	// Assert
	if tooSmall != nil {
		t.Fatal("a cap one byte below the block still rendered it")
	}
}

func TestSelectionLadderShapes(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	selected := []Selection{{Record: record}}
	full := render(t, selected, record, nil, false, false, MaximumBlockBytes)
	stateTooLarge := "stateTooLarge"
	failed := len(full.Bytes)

	// Act
	floor := render(t, selected, nil, &stateTooLarge, true, true, MaximumBlockBytes)
	ordinary := selectShape(t, 1, selected, record, nil)
	half := selectShape(t, 2, selected, record, &failed)
	withoutDiff := selectShape(t, 3, selected, record, nil)
	withoutState := selectShape(t, 4, selected, record, nil)

	// Assert
	if floor.StateIncluded || floor.EventCount != 1 || len(floor.Bytes) >= len(full.Bytes) || floor.Degraded == nil || *floor.Degraded != stateTooLarge {
		t.Fatalf("the floor candidate %+v is not one stateless header", floor)
	}
	if len(ordinary.Bytes) != len(full.Bytes) {
		t.Fatal("the ordinary ladder dropped part of the fitting prefix or state")
	}
	if half != nil {
		t.Fatal("the half-size shape rendered although the wanted state cannot fit")
	}
	if !withoutDiff.StateIncluded || withoutDiff.EventCount != 1 || len(withoutDiff.Bytes) >= len(ordinary.Bytes) {
		t.Fatalf("the third shape %+v does not keep state and drop the diff", withoutDiff)
	}
	if len(withoutState.Bytes) != len(floor.Bytes) {
		t.Fatal("the fourth shape is not the header-only floor")
	}
}

func TestOversizedStateReachesBoundedHeaderOnlyCandidate(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(MaximumBlockBytes, false))
	record := frozenRecord(t, accepted, true)
	backlog := make([]*Record, 8)
	for index := range backlog {
		backlog[index] = frozenRecord(t, accepted, false)
	}

	// Act
	limited := selectShape(t, 1, []Selection{{Record: record}}, record, nil)

	// Assert
	for _, retained := range backlog {
		if retained.State != nil {
			t.Fatal("a bounded backlog retained historical state text")
		}
	}
	if limited.StateIncluded || limited.EventCount != 1 || len(limited.Bytes) > MaximumBlockBytes || limited.Degraded == nil || *limited.Degraded != "stateTooLarge" {
		t.Fatalf("oversized state did not reach a disclosed header-only candidate: %+v", limited.Degraded)
	}
}

func TestRenderRefusesARepeatedEvent(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)

	// Act
	_, err := Render([]byte(codecTemplate), []Selection{{Record: record}, {Record: record, Redelivery: true}}, record, generation, nil, false, false,
		instructions, provider, MaximumBlockBytes)

	// Assert
	if !errors.Is(err, j.ErrInvalid) {
		t.Fatalf("a repeated event answered %v", err)
	}
}

// contextScope stages a canonical companion data root as the deleted New-StagedRuntimeContextRoot did.
type contextScope struct {
	root, input string
	request     map[string]any
}

func newContextScope(t *testing.T) *contextScope {
	t.Helper()
	admitted, err := nativefs.Admit(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	root := admitted.Path
	writeFile(t, filepath.Join(root, "scope.json"), []byte(scopeDocument))
	writeFile(t, filepath.Join(root, "state-safety.json"), []byte(safetyDocument))
	if err := os.MkdirAll(filepath.Join(root, "journal", "events"), 0o700); err != nil {
		t.Fatal(err)
	}
	request := map[string]any{
		"contextRequestVersion": 1, "scopeSha256": events.Sha256Hex([]byte(scopeDocument)), "safetySha256": events.Sha256Hex([]byte(safetyDocument)),
		"generation": generation, "journalId": "journal", "game": "game", "principal": "principal", "template": json.RawMessage(codecTemplate),
		"stateWanted": true, "shape": nil, "failedBlockBytes": nil, "instructionsSha256": instructions, "providerFingerprint": provider, "disclosure": false,
	}
	return &contextScope{root: root, input: filepath.Join(root, "prepared-context.txt."+strings.Repeat("a", 32)+".tmp"), request: request}
}

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (s *contextScope) storeEvent(t *testing.T, sequence int64, data []byte) {
	t.Helper()
	writeFile(t, filepath.Join(s.root, "journal", "events", fmt.Sprintf("%016d.json", sequence)), data)
}

type contextCandidate struct {
	Shape                 int    `json:"shape"`
	RedeliverySha256      string `json:"redeliverySha256"`
	RedeliveryBytes       int    `json:"redeliveryBytes"`
	RedeliveryChanges     int    `json:"redeliveryChanges"`
	RedeliveryOffsetDelta int    `json:"redeliveryOffsetDelta"`
}

type contextReply struct {
	Published         bool               `json:"published"`
	CleanupComplete   bool               `json:"cleanupComplete"`
	RedeliveryOffsets string             `json:"redeliveryOffsets"`
	Candidates        []contextCandidate `json:"candidates"`
	raw               []byte
}

func (s *contextScope) execute(t *testing.T, mode string) (contextReply, error) {
	t.Helper()
	input, err := json.Marshal(s.request)
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, s.input, input)
	raw, err := Execute(s.root, s.input, events.Sha256Hex(input), mode, func() error { return nil })
	if err != nil {
		return contextReply{}, err
	}
	reply := contextReply{raw: raw}
	if err := json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	return reply, nil
}

func (s *contextScope) mustExecute(t *testing.T, mode string) contextReply {
	t.Helper()
	reply, err := s.execute(t, mode)
	if err != nil {
		t.Fatalf("%s failed: %v", mode, err)
	}
	return reply
}

func packedOffset(t *testing.T, encoded string, index int) int {
	t.Helper()
	packed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(packed) < 4*(index+1) {
		t.Fatalf("offset vector %q has no slot %d", encoded, index)
	}
	return int(binary.LittleEndian.Uint32(packed[4*index:]))
}

func TestExecutePreviewPublishAndVerifyIdentifyTheSameRedelivery(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	full := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)
	redelivered, err := Redeliver(full, instructions, provider)
	if err != nil {
		t.Fatal(err)
	}
	scope := newContextScope(t)
	scope.storeEvent(t, 1, accepted)
	reference := map[string]any{"sequence": 1, "sha256": events.Sha256Hex(accepted)}
	scope.request["events"] = []any{map[string]any{"sequence": 1, "sha256": events.Sha256Hex(accepted), "redelivery": false}}
	scope.request["state"] = reference
	prepared := filepath.Join(scope.root, "prepared-context.txt")

	// Act
	preview := scope.mustExecute(t, "Preview")
	_, previewArtifact := os.Stat(prepared)
	scope.request["shape"] = 1
	published := scope.mustExecute(t, "Publish")
	publishedBytes, readErr := os.ReadFile(prepared)
	verified := scope.mustExecute(t, "Verify")

	// Assert
	if preview.Published || len(preview.Candidates) != 3 || !os.IsNotExist(previewArtifact) {
		t.Fatalf("preview published or returned %d candidates", len(preview.Candidates))
	}
	if !published.Published || !published.CleanupComplete || readErr != nil || !bytes.Equal(publishedBytes, full.Bytes) {
		t.Fatal("publication did not atomically publish the verified rendering")
	}
	if !verified.Published || verified.CleanupComplete {
		t.Fatal("lost-reply verification must prove the bytes without inventing cleanup evidence")
	}
	for _, reply := range []contextReply{preview, published, verified} {
		var first *contextCandidate
		for index := range reply.Candidates {
			if reply.Candidates[index].Shape == 1 {
				first = &reply.Candidates[index]
			}
		}
		if first == nil || first.RedeliverySha256 != events.Sha256Hex(redelivered.Bytes) || first.RedeliveryBytes != len(redelivered.Bytes) || first.RedeliveryChanges != 1 {
			t.Fatalf("a reply does not identify the same redelivery bytes: %+v", first)
		}
		if packedOffset(t, reply.RedeliveryOffsets, 0)+first.RedeliveryOffsetDelta != int(redelivered.Offsets[0]) {
			t.Fatal("the transported plan does not resolve the published flag offset")
		}
	}
}

func TestEveryShapeReconstructsItsAllTrueCandidateFromThePreviewPlan(t *testing.T) {
	// Arrange: four events from the same admitted payload, the second a redelivery.
	sample := newPayloadSample(0, true)
	pending, _ := sampleEvents(t, sample)
	recordHash := events.Sha256Hex(sample.source)
	scope := newContextScope(t)
	var mixed, allTrue []Selection
	var references []any
	var last []byte
	for sequence := int64(1); sequence <= 4; sequence++ {
		eventID := fmt.Sprintf("%032x", sequence)
		data, err := events.RewriteEvent(pending, eventMetadata(sequence, eventID, recordHash, true), false)
		if err != nil {
			t.Fatal(err)
		}
		record := frozenRecord(t, data, true)
		mixed = append(mixed, Selection{Record: record, Redelivery: sequence == 2})
		allTrue = append(allTrue, Selection{Record: record, Redelivery: true})
		references = append(references, map[string]any{"sequence": sequence, "sha256": events.Sha256Hex(data), "redelivery": sequence == 2})
		scope.storeEvent(t, sequence, data)
		last = data
	}
	state := frozenRecord(t, last, true)
	mixedFull := render(t, mixed, state, nil, false, false, MaximumBlockBytes)
	failed := len(mixedFull.Bytes)
	scope.request["events"] = references
	scope.request["state"] = map[string]any{"sequence": 4, "sha256": events.Sha256Hex(last)}
	scope.request["failedBlockBytes"] = failed

	// Act
	preview := scope.mustExecute(t, "Preview")

	// Assert
	if len(preview.Candidates) != 4 || len(preview.raw) > maximumReplyBytes {
		t.Fatalf("preview returned %d candidates in %d bytes", len(preview.Candidates), len(preview.raw))
	}
	prepared := filepath.Join(scope.root, "prepared-context.txt")
	for _, candidate := range preview.Candidates {
		primary := selectShape(t, candidate.Shape, mixed, state, &failed)
		scope.request["shape"] = candidate.Shape
		_ = os.Remove(prepared)
		selected := scope.mustExecute(t, "Publish")
		publishedBytes, err := os.ReadFile(prepared)
		if err != nil || !bytes.Equal(publishedBytes, primary.Bytes) {
			t.Fatalf("shape %d publication differs from its primary candidate", candidate.Shape)
		}
		if selected.Candidates[0].RedeliverySha256 != candidate.RedeliverySha256 {
			t.Fatalf("shape %d is not recoverable from its preview plan", candidate.Shape)
		}
		var expectedState *Record
		if primary.StateIncluded {
			expectedState = state
		}
		expected := render(t, allTrue[:primary.EventCount], expectedState, primary.Degraded, primary.Degraded != nil, false, MaximumBlockBytes)
		reconstructed := []byte{}
		sourceAt := 0
		for index := 0; index < candidate.RedeliveryChanges; index++ {
			offset := packedOffset(t, preview.RedeliveryOffsets, index) + candidate.RedeliveryOffsetDelta
			if string(primary.Bytes[offset:offset+5]) != "false" {
				t.Fatalf("shape %d offset %d does not index a false token", candidate.Shape, offset)
			}
			reconstructed = append(append(reconstructed, primary.Bytes[sourceAt:offset]...), "true"...)
			sourceAt = offset + 5
		}
		reconstructed = append(reconstructed, primary.Bytes[sourceAt:]...)
		if !bytes.Equal(reconstructed, expected.Bytes) || events.Sha256Hex(reconstructed) != candidate.RedeliverySha256 || len(reconstructed) != candidate.RedeliveryBytes {
			t.Fatalf("shape %d plan does not reproduce the all-true candidate", candidate.Shape)
		}
		if primary.Fingerprint != expected.Fingerprint {
			t.Fatalf("shape %d changed its semantic identity across redelivery", candidate.Shape)
		}
	}
}

func TestEmptyAndAllTrueRenderingsNeedNoRedeliveryChange(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	empty := render(t, []Selection{}, nil, nil, false, false, MaximumBlockBytes)
	allTrue := render(t, []Selection{{Record: record, Redelivery: true}}, record, nil, false, false, MaximumBlockBytes)

	// Act
	emptyRedelivery, emptyErr := Redeliver(empty, instructions, provider)
	allTrueRedelivery, allTrueErr := Redeliver(allTrue, instructions, provider)
	plan, planErr := PackRedeliveryOffsets([]*Redelivered{emptyRedelivery, allTrueRedelivery})

	// Assert
	if emptyErr != nil || allTrueErr != nil || planErr != nil {
		t.Fatalf("redelivery failed: %v %v %v", emptyErr, allTrueErr, planErr)
	}
	if len(emptyRedelivery.Offsets) != 0 || !bytes.Equal(emptyRedelivery.Bytes, empty.Bytes) || len(allTrueRedelivery.Offsets) != 0 {
		t.Fatal("renderings without false direct flags changed under redelivery")
	}
	if len(plan.Encoded) != 0 || plan.Deltas[0] != 0 || plan.Deltas[1] != 0 {
		t.Fatalf("empty plans packed %d bytes with deltas %v", len(plan.Encoded), plan.Deltas)
	}
}

func TestRedeliveryFindsAllDirectFlagsAtTheEventCeiling(t *testing.T) {
	// Arrange
	items := make([]string, MaximumEvents)
	for index := range items {
		items[index] = `{"redelivery":false,"diff":{"redelivery":false}}`
	}
	document := `{"events":[` + strings.Join(items, ",") + `],"state":null}`
	fingerprint, err := Fingerprint([]byte(document), instructions, provider)
	if err != nil {
		t.Fatal(err)
	}
	rendered := &Rendering{Bytes: []byte(contextOpening + document + contextClosing), Fingerprint: fingerprint, EventCount: MaximumEvents}

	// Act
	redelivered, err := Redeliver(rendered, instructions, provider)

	// Assert
	if err != nil || len(redelivered.Offsets) != MaximumEvents || len(redelivered.Bytes) != len(rendered.Bytes)-MaximumEvents {
		t.Fatalf("the scanner did not find exactly the direct flags: %v", err)
	}
}

func TestOffsetPlanAtTheCeilingFitsOneControlReply(t *testing.T) {
	// Arrange
	maximumOffsets := make([]uint32, MaximumEvents)
	shifted := make([]uint32, MaximumEvents)
	for index := range maximumOffsets {
		maximumOffsets[index] = uint32(100 + 20*index)
		shifted[index] = maximumOffsets[index] + 10
	}
	maximum := &Redelivered{Bytes: []byte{}, Offsets: maximumOffsets}
	plans := []*Redelivered{maximum, {Bytes: []byte{}, Offsets: []uint32{90, 110}}, {Bytes: []byte{}, Offsets: shifted}, {Bytes: []byte{}, Offsets: []uint32{}}}
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	record := frozenRecord(t, accepted, true)
	full := render(t, []Selection{{Record: record}}, record, nil, false, false, MaximumBlockBytes)

	// Act
	plan, err := PackRedeliveryOffsets(plans)
	candidates := make([]candidate, 4)
	for index := range candidates {
		candidates[index] = candidate{index + 1, full, maximum, strings.Repeat("a", 64), strings.Repeat("b", 64)}
	}
	reply, replyErr := createReply(strings.Repeat("a", 64), candidates, plan, false, false)
	_, inconsistent := PackRedeliveryOffsets([]*Redelivered{maximum, {Bytes: []byte{}, Offsets: []uint32{90, 111}}})

	// Assert
	encoded := base64.StdEncoding.EncodeToString(plan.Encoded)
	if err != nil || len(encoded) != 43692 || len(plan.Encoded) != 4*MaximumEvents {
		t.Fatalf("the maximum vector packed into %d base64 bytes: %v", len(encoded), err)
	}
	if plan.Deltas[0] != 0 || plan.Deltas[1] != -10 || plan.Deltas[2] != 10 || plan.Deltas[3] != 0 {
		t.Fatalf("the first-longest vector does not govern every prefix: %v", plan.Deltas)
	}
	var document contextReply
	if replyErr != nil || len(reply) > maximumReplyBytes || json.Unmarshal(reply, &document) != nil || document.RedeliveryOffsets != encoded {
		t.Fatalf("the four-candidate reply does not carry the complete vector within the bound: %v", replyErr)
	}
	if !errors.Is(inconsistent, j.ErrInvalid) {
		t.Fatalf("an inconsistent plan answered %v", inconsistent)
	}
}

func TestExecuteRefusesAChangedStateSafetyDocument(t *testing.T) {
	// Arrange
	_, accepted := sampleEvents(t, newPayloadSample(0, true))
	scope := newContextScope(t)
	scope.storeEvent(t, 1, accepted)
	scope.request["events"] = []any{map[string]any{"sequence": 1, "sha256": events.Sha256Hex(accepted), "redelivery": false}}
	scope.request["state"] = map[string]any{"sequence": 1, "sha256": events.Sha256Hex(accepted)}
	writeFile(t, filepath.Join(scope.root, "state-safety.json"), []byte("{}"))

	// Act
	_, err := scope.execute(t, "Preview")

	// Assert
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("a changed state-safety document answered %v", err)
	}
}
