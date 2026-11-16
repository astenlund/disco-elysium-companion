package inventory

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"companion-helper/internal/nativefs"
)

// productionDepthBudget is well inside the runtime's 30-second inventory budget, so a repeated read of the
// retained-event ceiling at production depth keeps room for slower machines.
const productionDepthBudget = 15 * time.Second

// The budget gates a second read of the same files. The first read of newly written files can be dominated by the
// host's on-access scanning of each first open, which the helper does not control, so its time is logged, not gated.
func TestInventoryOfTheEventCeilingAtProductionDepthFitsTheBudget(t *testing.T) {
	// Arrange: a scope at least as deep as a checkout's runtime-data/g-<hash>/p-<hash> data root, holding compact events
	// past the retained-event ceiling, read once so the timed read opens files the host has already seen.
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
	components := strings.Count(scope, `\`)
	logRead := func(kind string, elapsed time.Duration) {
		t.Logf("%s inventory of %d events under a data root of %d path components took %v (%.3f ms per event)", kind,
			compactEventCount, components, elapsed, float64(elapsed.Microseconds())/1000/compactEventCount)
	}
	started := time.Now()
	fixture.read(t, false)
	logRead("first", time.Since(started))

	// Act
	started = time.Now()
	result := fixture.read(t, false)
	elapsed := time.Since(started)

	// Assert
	logRead("repeated", elapsed)
	if result.PotentialHandoffs != compactEventCount {
		t.Fatalf("the ceiling history was not admitted: %+v", result)
	}
	if elapsed >= productionDepthBudget {
		t.Fatalf("repeated inventory of the event ceiling took %v, not within %v", elapsed, productionDepthBudget)
	}
}
