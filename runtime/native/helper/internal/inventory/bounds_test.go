package inventory

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"companion-helper/internal/nativefs"
)

// countingGate counts its calls and refuses once more than allowed calls have been made.
func countingGate(calls *int, allowed int) nativefs.Gate {
	return func() error {
		*calls++
		if *calls > allowed {
			return nativefs.ErrDeadline
		}
		return nil
	}
}

func TestOutboxWalkRefusesAtItsEntryBoundWithoutReadingTheRest(t *testing.T) {
	// Arrange: an outbox far past the entry bound, and a gate that never refuses but counts the entries visited.
	fixture := newResourceScope(t)
	for index := 0; index < outboxEntryLimit+500; index++ {
		writeTestFile(t, fixture.outbox(fmt.Sprintf("note-%05d.txt", index)), "x")
	}
	calls := 0

	// Act
	_, err := Read(fixture.scope, fixture.hash, false, fixture.companion, countingGate(&calls, 1<<30))

	// Assert: one call for scope.json, then the outbox walk stops at the first entry past the bound.
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("an outbox past its entry bound answered %v", err)
	}
	if calls != 1+outboxEntryLimit+1 {
		t.Fatalf("the outbox walk visited %d entries in all instead of stopping at the bound", calls)
	}
}

func TestExpiredGateStopsTheScopeWalkBeforeReadingFurther(t *testing.T) {
	// Arrange: a scope with more entries than the gate allows.
	fixture := newResourceScope(t)
	for index := 0; index < 20; index++ {
		writeTestFile(t, filepath.Join(fixture.scope, "quarantine", fmt.Sprintf("q%02d.%032x.quarantined", index, index)), "x")
	}
	calls := 0

	// Act
	_, err := Read(fixture.scope, fixture.hash, false, fixture.companion, countingGate(&calls, 5))

	// Assert: the walk refuses with the deadline at the first expired check and checks nothing after it.
	if !errors.Is(err, nativefs.ErrDeadline) {
		t.Fatalf("an expired gate answered %v", err)
	}
	if calls != 6 {
		t.Fatalf("the walk consulted the gate %d times after it expired", calls-6)
	}
}

func TestExpiredGateStopsTheQuarantineTrimBeforeAnyDeletion(t *testing.T) {
	// Arrange: more quarantined files than the retention limit, and a gate that expires during the listing.
	fixture := newResourceScope(t)
	for index := 0; index < quarantineFileLimit+3; index++ {
		writeTestFile(t, filepath.Join(fixture.scope, "quarantine", fmt.Sprintf("q%03d.%032x.quarantined", index, index)), "x")
	}
	calls := 0

	// Act
	_, err := TrimQuarantine(fixture.scope, fixture.hash, []byte(`[]`), countingGate(&calls, 10))
	remaining, listErr := nativefs.ListDirectory(filepath.Join(fixture.scope, "quarantine"))

	// Assert
	if !errors.Is(err, nativefs.ErrDeadline) || listErr != nil {
		t.Fatalf("an expired gate answered %v, listing %v", err, listErr)
	}
	if len(remaining) != quarantineFileLimit+3 {
		t.Fatalf("the trim deleted %d files after its gate expired", quarantineFileLimit+3-len(remaining))
	}
}
