package inventory

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion-helper/internal/nativefs"
)

// productionDepthBudget is well inside the runtime's 30-second inventory budget, so a read of the retained-event
// ceiling at production depth keeps room for slower machines.
const productionDepthBudget = 15 * time.Second

func TestInventoryOfTheEventCeilingAtProductionDepthFitsTheBudget(t *testing.T) {
	// Arrange: a scope at least as deep as a checkout's runtime-data/g-<hash>/p-<hash> data root, holding compact events
	// past the retained-event ceiling.
	admitted, err := nativefs.Admit(t.TempDir(), false)
	if err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("0", 64)
	scope := filepath.Join(admitted.Path, "Git", "disco-elysium-companion", "runtime-data", "g-"+hash, "p-"+hash)
	writeTestFile(t, filepath.Join(scope, "scope.json"), resourceScope)
	fixture := &resourceScopeFixture{companion: admitted.Path, scope: scope, hash: sha256Hex([]byte(resourceScope))}
	for sequence := 1; sequence <= compactEventCount; sequence++ {
		writeTestFile(t, eventPath(fixture, sequence), compactEvent(sequence))
	}

	// Act
	started := time.Now()
	result := fixture.read(t, false)
	elapsed := time.Since(started)

	// Assert
	t.Logf("inventory of %d events under a data root of %d path components took %v (%.3f ms per event)", compactEventCount,
		strings.Count(scope, `\`), elapsed, float64(elapsed.Microseconds())/1000/compactEventCount)
	if result.PotentialHandoffs != compactEventCount {
		t.Fatalf("the ceiling history was not admitted: %+v", result)
	}
	if elapsed >= productionDepthBudget {
		t.Fatalf("inventory of the event ceiling took %v, not within %v", elapsed, productionDepthBudget)
	}
}
