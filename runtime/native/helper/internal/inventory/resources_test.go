package inventory

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	j "companion-helper/internal/jsondoc"
	"companion-helper/internal/nativefs"
)

// These cases were carried over from the deleted resource-lifecycle/Test-ResourceInventory.ps1 suite. The handoff
// operations are the output of runtime/test/support/handoff-digest-fixture.ts for this scope's hash, and the expected
// digests are the vectors that runtime/test/support/handoff-digest-vectors.json shares with the TypeScript tests.

const (
	resourceScope = `{"runtimeScopeVersion":1,"game":"test","principal":"test"}`
	// compactEventCount exceeds the retained-event ceiling by one, as the deleted suite did.
	compactEventCount = 8193
)

var sequenceField = regexp.MustCompile(`"sequence":[0-9]+`)

type inventoryResult struct {
	UncompactedEvents             int    `json:"uncompactedEvents"`
	RetainedHandoffs              int    `json:"retainedHandoffs"`
	RetainedHandoffIdentitySha256 string `json:"retainedHandoffIdentitySha256"`
	PotentialHandoffs             int    `json:"potentialHandoffs"`
	FullTerminalOperations        int    `json:"fullTerminalOperations"`
	InvalidEvents                 int    `json:"invalidEvents"`
	InvalidOperations             int    `json:"invalidOperations"`
	PendingOutbox                 int    `json:"pendingOutbox"`
	UncertainWorkspace            bool   `json:"uncertainWorkspace"`
	FreeBytes                     string `json:"freeBytes"`
}

type digestVector struct {
	RetainedHandoffs int    `json:"retainedHandoffs"`
	Sha256           string `json:"sha256"`
}

type digestVectors struct {
	Empty    digestVector `json:"empty"`
	Nonempty digestVector `json:"nonempty"`
}

// resourceScopeFixture is a scope directory inside a canonical companion root, which also holds state/outbox.
type resourceScopeFixture struct {
	companion, scope, hash string
}

func newResourceScope(t *testing.T) *resourceScopeFixture {
	t.Helper()
	admitted, err := nativefs.Admit(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	scope := filepath.Join(admitted.Path, "scope")
	writeTestFile(t, filepath.Join(scope, "scope.json"), resourceScope)
	return &resourceScopeFixture{companion: admitted.Path, scope: scope, hash: sha256Hex([]byte(resourceScope))}
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func removeTestFile(t *testing.T, path string) {
	t.Helper()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}

func (f *resourceScopeFixture) read(t *testing.T, markerOnly bool) inventoryResult {
	t.Helper()
	data, err := Read(f.scope, f.hash, markerOnly, f.companion)
	if err != nil {
		t.Fatalf("inventory failed: %v", err)
	}
	var result inventoryResult
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func (f *resourceScopeFixture) outbox(name string) string {
	return filepath.Join(f.companion, "state", "outbox", name)
}

func loadDigestVectors(t *testing.T) digestVectors {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "support", "handoff-digest-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors digestVectors
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	return vectors
}

// handoffOperations returns the builder's two full repair records as exact bytes, plus the first with its handoffs reversed.
func handoffOperations(t *testing.T) (ordered, reversed, second []byte, ids [2]string) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "handoff-operations.json"))
	if err != nil {
		t.Fatal(err)
	}
	root, err := j.Parse(data, j.StateEvent)
	if err != nil {
		t.Fatal(err)
	}
	operations := root.Get("operations").Items
	if len(operations) != 2 {
		t.Fatalf("the digest fixture holds %d records", len(operations))
	}
	for index, operation := range operations {
		ids[index] = operation.Get("operationId").Str
		if operation.Get("kind").Str != "repair" || operation.Get("compacted").Kind == j.True || operation.Get("scopeSha256").Str != sha256Hex([]byte(resourceScope)) {
			t.Fatal("the digest fixture is not a full repair for this scope")
		}
	}
	handoffs := operations[0].Get("plan").Get("handoffs")
	items := make([][]byte, len(handoffs.Items))
	for index, item := range handoffs.Items {
		items[len(items)-1-index] = item.Raw
	}
	reversedHandoffs := append(append([]byte("["), bytes.Join(items, []byte(","))...), ']')
	reversed = bytes.Replace(operations[0].Raw, handoffs.Raw, reversedHandoffs, 1)
	return operations[0].Raw, reversed, operations[1].Raw, ids
}

func TestEmptyInventoryChargesNothingAndMatchesTheEmptyDigestVector(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	vectors := loadDigestVectors(t)

	// Act
	empty := fixture.read(t, false)

	// Assert
	free, err := strconv.ParseUint(empty.FreeBytes, 10, 64)
	if empty.UncompactedEvents != 0 || empty.RetainedHandoffs != 0 || err != nil || free == 0 {
		t.Fatalf("the empty inventory was not admitted: %+v", empty)
	}
	if empty.PendingOutbox != 0 {
		t.Fatal("an absent outbox was charged speculative records")
	}
	if empty.RetainedHandoffs != vectors.Empty.RetainedHandoffs || empty.RetainedHandoffIdentitySha256 != vectors.Empty.Sha256 {
		t.Fatal("the empty native digest differs from the shared vector")
	}
}

func TestHandoffDigestMatchesTheSharedVectorForOrderedReversedAndDuplicateRecords(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	vectors := loadDigestVectors(t)
	ordered, reversed, second, ids := handoffOperations(t)
	first := filepath.Join(fixture.scope, "operations", ids[0]+".json")
	other := filepath.Join(fixture.scope, "operations", ids[1]+".json")

	// Act
	writeTestFile(t, first, string(ordered))
	orderedResult := fixture.read(t, false)
	writeTestFile(t, first, string(reversed))
	reversedResult := fixture.read(t, false)
	writeTestFile(t, other, string(second))
	duplicated := fixture.read(t, false)
	marker := fixture.read(t, true)
	removeTestFile(t, first)
	removeTestFile(t, other)
	cleared := fixture.read(t, false)

	// Assert
	for name, result := range map[string]inventoryResult{"ordered": orderedResult, "reversed": reversedResult} {
		if result.InvalidOperations != 0 || result.FullTerminalOperations != 1 {
			t.Fatalf("the %s record was not admitted: %+v", name, result)
		}
		if result.RetainedHandoffs != vectors.Nonempty.RetainedHandoffs || result.RetainedHandoffIdentitySha256 != vectors.Nonempty.Sha256 {
			t.Fatalf("the %s native digest differs from the shared vector", name)
		}
	}
	if duplicated.InvalidOperations != 0 || duplicated.FullTerminalOperations != 2 {
		t.Fatalf("both full repair records must be admitted: %+v", duplicated)
	}
	if duplicated.RetainedHandoffs != vectors.Nonempty.RetainedHandoffs || duplicated.RetainedHandoffIdentitySha256 != vectors.Nonempty.Sha256 {
		t.Fatal("the native digest double-counted identities retained across records")
	}
	if marker.RetainedHandoffs != vectors.Empty.RetainedHandoffs || marker.RetainedHandoffIdentitySha256 != vectors.Empty.Sha256 {
		t.Fatal("the marker digest did not keep its empty-set placeholder")
	}
	if cleared.FullTerminalOperations != 0 || cleared.InvalidOperations != 0 || cleared.RetainedHandoffIdentitySha256 != vectors.Empty.Sha256 {
		t.Fatalf("removing the records did not restore the empty baseline: %+v", cleared)
	}
}

func TestOutboxCountsOnlyRuntimeRecordsInTheSequenceDomain(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	for index := 1; index <= 16; index++ {
		writeTestFile(t, fixture.outbox(fmt.Sprintf("event-%016d.json", index)), "{}")
	}

	// Act
	existing := fixture.read(t, false).PendingOutbox
	for index := 1; index <= 16; index++ {
		removeTestFile(t, fixture.outbox(fmt.Sprintf("event-%016d.json", index)))
	}
	for _, name := range []string{"event-0000000000000000.json", "event-0000000000000001.json", "event-9007199254740991.json", "event-9007199254740992.json"} {
		writeTestFile(t, fixture.outbox(name), "{}")
	}
	bounded := fixture.read(t, false).PendingOutbox

	// Assert
	if existing != 16 {
		t.Fatalf("existing outbox records counted %d", existing)
	}
	if bounded != 2 {
		t.Fatalf("out-of-domain files were counted as pending records: %d", bounded)
	}
}

func TestMarkerInventoryChargesItsOwnResidue(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	writeTestFile(t, filepath.Join(fixture.scope, "runtime.json."+strings.Repeat("f", 32)+".tmp"), "{}")

	// Act
	marker := fixture.read(t, true)

	// Assert
	if !marker.UncertainWorkspace {
		t.Fatal("the marker inventory ignored its own residue")
	}
}

func compactEvent(sequence int) string {
	eventID := fmt.Sprintf("%032x", sequence)
	return `{"eventVersion":1,"journalId":"journal","sequence":` + strconv.Itoa(sequence) + `,"eventId":"` + eventID +
		`","type":"state.consumed","occurredAt":"2026-10-08T00:00:00.0000000Z","runtimeInstanceId":"` + strings.Repeat("b", 32) +
		`","adapter":"test","adapterBindingEpoch":"` + strings.Repeat("c", 32) + `","principal":"test","logicalOutboxId":"` + strings.Repeat("d", 32) + "-" +
		strconv.Itoa(sequence) + `","recordSha256":"` + sha256Hex([]byte("{}")) + `","coreRepairOperationId":null,"attemptRef":null,"schemaVersion":2,` +
		`"adapterVersion":1,"settlement":"accepted","acceptance":{"journalId":"journal","eventId":"` + eventID + `","generation":"` + strings.Repeat("f", 32) +
		`"},"acknowledgedAt":"2026-10-08T00:00:00.0000000Z","compacted":true,"payloadBindingSha256":"` + strings.Repeat("0", 64) + `"}`
}

func eventPath(f *resourceScopeFixture, sequence int) string {
	return filepath.Join(f.scope, "journal", "events", fmt.Sprintf("%016d.json", sequence))
}

func TestCompactHistoryPastTheEventCeilingAdmitsEveryIdentity(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	for sequence := 1; sequence <= compactEventCount; sequence++ {
		writeTestFile(t, eventPath(fixture, sequence), compactEvent(sequence))
	}

	// Act
	compact := fixture.read(t, false)

	// Assert
	if compact.UncompactedEvents != 0 || compact.InvalidEvents != 0 || compact.PotentialHandoffs != compactEventCount {
		t.Fatalf("the complete compact history was not admitted: %+v", compact)
	}
}

func TestMalformedEventSequencesRemainInvalidAuthority(t *testing.T) {
	// Arrange: a short compact history, since the property holds per event.
	const history = 3
	fixture := newResourceScope(t)
	for sequence := 1; sequence <= history; sequence++ {
		writeTestFile(t, eventPath(fixture, sequence), compactEvent(sequence))
	}
	for _, bad := range []string{"1.5", "9223372036854775808", `"1"`, "null"} {
		writeTestFile(t, eventPath(fixture, 1), sequenceField.ReplaceAllString(compactEvent(1), `"sequence":`+bad))

		// Act
		invalid := fixture.read(t, false)

		// Assert
		if invalid.InvalidEvents != 1 || invalid.UncompactedEvents != 1 || invalid.PotentialHandoffs != history-1 {
			t.Fatalf("a sequence of %s did not remain invalid authority: %+v", bad, invalid)
		}
	}
}

func TestJournaledOutboxSourceIsNotChargedAgainUnlessItsBytesChanged(t *testing.T) {
	// Arrange: one compact journaled event whose source record is the two bytes "{}" at logical sequence one.
	fixture := newResourceScope(t)
	writeTestFile(t, eventPath(fixture, 1), compactEvent(1))
	duplicate := fixture.outbox("event-0000000000000001.json")

	// Act
	writeTestFile(t, duplicate, "{}")
	exact := fixture.read(t, false).PendingOutbox
	writeTestFile(t, duplicate, `{"changed":true}`)
	changed := fixture.read(t, false).PendingOutbox

	// Assert
	if exact != 0 {
		t.Fatal("the exact journaled source was charged as a new append")
	}
	if changed != 1 {
		t.Fatal("changed outbox bytes inherited duplicate capacity")
	}
}

func TestDamagedEventsAreCountedAndMarkerInventoryIgnoresThem(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	for sequence := 1; sequence <= compactEventCount; sequence++ {
		writeTestFile(t, eventPath(fixture, sequence), "{")
	}

	// Act
	damaged := fixture.read(t, false)
	marker := fixture.read(t, true)

	// Assert
	if damaged.UncompactedEvents != compactEventCount || damaged.InvalidEvents != compactEventCount {
		t.Fatalf("damaged events were truncated or counted as clean: %+v", damaged)
	}
	if marker.UncertainWorkspace {
		t.Fatal("the marker-only inventory imported event authority")
	}
}

func TestInvalidOperationsAndPreparedContextResidueAreCharged(t *testing.T) {
	// Arrange
	fixture := newResourceScope(t)
	writeTestFile(t, filepath.Join(fixture.scope, "operations", "jr-"+strings.Repeat("a", 32)+".json"), `{"oops":true}`)

	// Act
	invalid := fixture.read(t, false)
	writeTestFile(t, filepath.Join(fixture.scope, "prepared-context.txt"), "stale")
	residue := fixture.read(t, false)

	// Assert
	if invalid.InvalidOperations != 1 {
		t.Fatal("invalid operation authority was silently ignored")
	}
	if !residue.UncertainWorkspace {
		t.Fatal("prepared-context residue was not charged")
	}
}

func TestQuarantineTrimUsesOrdinalOldestOrderAndNeverPrunesProtectedFiles(t *testing.T) {
	// Arrange: 257 equally old files, one past the production count.
	fixture := newResourceScope(t)
	names := make([]string, 257)
	written := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	for index := range names {
		names[index] = fmt.Sprintf("record.%04d.%s.quarantined", index, strings.Repeat("a", 32))
		path := filepath.Join(fixture.scope, "quarantine", names[index])
		writeTestFile(t, path, "diagnostic")
		if err := os.Chtimes(path, written, written); err != nil {
			t.Fatal(err)
		}
	}
	quarantined := func(name string) bool {
		_, err := os.Stat(filepath.Join(fixture.scope, "quarantine", name))
		return err == nil
	}
	protectedList := func(selected []string) []byte {
		paths := make([]string, len(selected))
		for index, name := range selected {
			paths[index] = "quarantine/" + name
		}
		data, _ := json.Marshal(paths)
		return data
	}

	// Act
	trimmed, trimErr := TrimQuarantine(fixture.scope, fixture.hash, protectedList(names[:1]), nativefs.NoDeadline)
	firstKept, secondRemoved := quarantined(names[0]), !quarantined(names[1])
	writeTestFile(t, filepath.Join(fixture.scope, "quarantine", names[1]), "diagnostic")
	retained, retainErr := TrimQuarantine(fixture.scope, fixture.hash, protectedList(names), nativefs.NoDeadline)

	// Assert
	if trimErr != nil || string(trimmed) != `{"removed":1,"remaining":256}` {
		t.Fatalf("quarantine did not keep the production count: %s %v", trimmed, trimErr)
	}
	if !firstKept || !secondRemoved {
		t.Fatal("quarantine ignored the protected manifest or ordinal oldest order")
	}
	if retainErr != nil || string(retained) != `{"removed":0,"remaining":257}` {
		t.Fatalf("protected quarantine was pruned: %s %v", retained, retainErr)
	}
}

func TestEventExpansionAdmitsAValidEventAndRefusesDamagedBytes(t *testing.T) {
	// Arrange: a pending event from the events package's committed fixtures.
	valid, err := os.ReadFile(filepath.Join("..", "events", "testdata", "event-created.json"))
	if err != nil {
		t.Fatal(err)
	}

	// Act
	admitted, admittedErr := CheckEventExpansion(valid)
	_, damagedErr := CheckEventExpansion([]byte("{"))

	// Assert
	if admittedErr != nil || string(admitted) != `{"admitted":true}` {
		t.Fatalf("a valid event was not admitted: %s %v", admitted, admittedErr)
	}
	if !errors.Is(damagedErr, ErrUnavailable) {
		t.Fatalf("damaged event bytes answered %v", damagedErr)
	}
}
